#!/usr/bin/env node
// 自己テスト。ネットワーク不要。
//
//   node scripts/selftest.mjs
//
// 目的は2つ:
//   1. schema/account.schema.json と validate-core.mjs の定義のズレを検出する
//      （片方だけ直して気づかない、という壊れ方をCIで止める）
//   2. 報告フォームに入りがちな変な入力に対する挙動を固定する

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  parseTweetUrl,
  classifyAccountInput,
  isCanonicalTweetUrl,
} from "./lib/x.mjs";
import {
  validateAccount,
  CATEGORIES,
  STATUSES,
  SEVERITIES,
} from "./lib/validate-core.mjs";
import { parseIssueForm, parseCheckboxes } from "./lib/issue-form.mjs";
import {
  parseAccounts,
  parseCategories,
  parseEvidence,
  groupEvidence,
  describeAccounts,
} from "./lib/report-input.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) return;
  failed++;
  console.error(`✖ ${name}${detail ? `\n    ${detail}` : ""}`);
};
const eq = (name, actual, expected) =>
  check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `期待: ${JSON.stringify(expected)}\n    実際: ${JSON.stringify(actual)}`,
  );

// --------------------------------------------------------------------------
// 1. スキーマとバリデータの突き合わせ
// --------------------------------------------------------------------------
const schemaPath = path.join(ROOT, "schema/account.schema.json");
let schema;
try {
  schema = JSON.parse(await readFile(schemaPath, "utf8"));
} catch (e) {
  console.error(`✖ schema/account.schema.json を読めません: ${e.message}`);
  process.exit(1);
}
const props = schema.properties;

eq("categories の一覧が一致", props.categories.items.enum, CATEGORIES);
eq("status の一覧が一致", props.status.enum, STATUSES);
eq("severity の一覧が一致", props.severity.enum, SEVERITIES);

// validate-core が受け付けるキー集合をエラー経由で逆算する
const schemaKeys = Object.keys(props).sort();
const unknownKeyErrors = validateAccount(
  Object.fromEntries(schemaKeys.map((k) => [k, undefined])),
).errors.filter((e) => e.startsWith("未知のフィールド"));
eq("トップレベルのキー集合が一致", unknownKeyErrors, []);

const evidenceKeys = Object.keys(schema.properties.evidence.items.properties);
const evKeyErrors = validateAccount({
  evidence: [Object.fromEntries(evidenceKeys.map((k) => [k, undefined]))],
}).errors.filter((e) => e.includes("に未知のフィールド"));
eq("evidence のキー集合が一致", evKeyErrors, []);

check(
  "schema の required が validate-core でも必須",
  ["id", "username", "categories", "evidence", "added_at", "updated_at"].every(
    (k) => schema.required.includes(k),
  ),
);

// カテゴリは5か所に書かれている。どれか一つだけ追加して気づかない、を止める。
// （報告フォームにないカテゴリは誰も選べないし、
// 　POLICY.md に定義がないカテゴリは掲載の根拠にならない）
const sorted = (a) => [...a].sort();

const reportForm = await readFile(
  path.join(ROOT, ".github/ISSUE_TEMPLATE/1-report.yml"),
  "utf8",
);
const formCategories = (
  reportForm.match(/^ {6}options:\n((?:^ {8}- [a-z-]+\n)+)/m)?.[1] ?? ""
)
  .trim()
  .split("\n")
  .map((l) => l.replace(/^\s*-\s*/, ""));
eq(
  "報告フォームのカテゴリ一覧が一致",
  sorted(formCategories),
  sorted(CATEGORIES),
);

const policy = await readFile(path.join(ROOT, "POLICY.md"), "utf8");
const policyCategories = [...policy.matchAll(/^\| `([a-z-]+)` \|/gm)].map(
  (m) => m[1],
);
eq(
  "POLICY.md のカテゴリ表が一致",
  sorted(policyCategories),
  sorted(CATEGORIES),
);

const readme = await readFile(path.join(ROOT, "README.md"), "utf8");
const readmeSection = readme.match(/\n## カテゴリ\n([\s\S]*?)\n## /)?.[1] ?? "";
const readmeCategories = [
  ...new Set([...readmeSection.matchAll(/`([a-z][a-z-]+)`/g)].map((m) => m[1])),
];
eq(
  "README.md のカテゴリ表が一致",
  sorted(readmeCategories),
  sorted(CATEGORIES),
);

// --------------------------------------------------------------------------
// 2. URL の解釈
// --------------------------------------------------------------------------
const canonical = "https://x.com/jack/status/20";
for (const [input, expected] of [
  [canonical, canonical],
  ["https://twitter.com/jack/status/20?s=20&t=xyz", canonical],
  ["https://mobile.twitter.com/jack/status/20", canonical],
  ["https://vxtwitter.com/jack/status/20", canonical],
  ["https://fxtwitter.com/jack/status/20/photo/1", canonical],
  ["https://x.com/jack/statuses/20", canonical],
  ["  x.com/jack/status/20  ", canonical],
  ["https://example.com/jack/status/20", null],
  ["https://x.com/jack", null],
  ["https://x.com/jack/status/abc", null],
  ["", null],
  [null, null],
]) {
  eq(
    `parseTweetUrl(${JSON.stringify(input)})`,
    parseTweetUrl(input)?.canonical ?? null,
    expected,
  );
}
check("正規形の判定", isCanonicalTweetUrl(canonical));
check("非正規形の判定", !isCanonicalTweetUrl(`${canonical}?s=20`));

// --------------------------------------------------------------------------
// 3. 対象アカウント入力の分類
// --------------------------------------------------------------------------
for (const [input, kind, value] of [
  ["@jack", "handle", "jack"],
  ["jack", "handle", "jack"],
  ["https://x.com/jack", "handle", "jack"],
  ["https://twitter.com/jack/", "handle", "jack"],
  ["https://x.com/i/user/12", "numeric-id", "12"],
  ["1234567890123456789", "numeric-id", "1234567890123456789"],
  ["12345", "ambiguous", "12345"],
  ["日本語のなまえ", "invalid", undefined],
  ["thisusernameiswaytoolong", "invalid", undefined],
  ["https://example.com/jack", "invalid", undefined],
  ["", "invalid", undefined],
]) {
  const c = classifyAccountInput(input);
  eq(
    `classifyAccountInput(${JSON.stringify(input)})`,
    [c.kind, c.value],
    [kind, value],
  );
}

// --------------------------------------------------------------------------
// 4. バリデーション
// --------------------------------------------------------------------------
const base = {
  id: "12",
  username: "jack",
  categories: ["ai-slop"],
  evidence: [{ url: canonical }],
  added_at: "2026-01-01",
  updated_at: "2026-01-01",
};
const errs = (patch) =>
  validateAccount({ ...base, ...patch }, { filename: "12.json" }).errors;
const warns = (patch) =>
  validateAccount({ ...base, ...patch }, { filename: "12.json" }).warnings;

eq("正常なデータは通る", errs({}), []);
check(
  "ファイル名の不一致を弾く",
  validateAccount(base, { filename: "13.json" }).errors.length === 1,
);
check("未知のカテゴリを弾く", errs({ categories: ["nope"] }).length > 0);
check("カテゴリ空を弾く", errs({ categories: [] }).length > 0);
check(
  "カテゴリ重複を弾く",
  errs({ categories: ["ai-slop", "ai-slop"] }).length > 0,
);
check("未知のフィールドを弾く", errs({ hoge: 1 }).length > 0);
check("証拠なしを弾く", errs({ evidence: [] }).length > 0);
check(
  "非正規形のURLを弾く",
  errs({ evidence: [{ url: `${canonical}?s=20` }] }).length > 0,
);
check(
  "同じツイートの重複を弾く",
  errs({ evidence: [{ url: canonical }, { url: canonical }] }).length > 0,
);
check("日付形式を弾く", errs({ added_at: "2026/01/01" }).length > 0);
check(
  "15文字超のusernameを弾く",
  errs({ username: "a".repeat(16) }).length > 0,
);
check("不正なstatusを弾く", errs({ status: "unknown" }).length > 0);
check(
  "メールアドレスを弾く",
  errs({ note: "連絡先 foo@example.com" }).length > 0,
);
check("電話番号を弾く", errs({ note: "090-1234-5678" }).length > 0);
check(
  "unavailable_since の形式を弾く",
  errs({ evidence: [{ url: canonical, unavailable_since: "きのう" }] }).length >
    0,
);
check(
  "証拠が全滅かつ魚拓なしを警告",
  warns({
    evidence: [{ url: canonical, unavailable_since: "2026-01-02" }],
  }).some((w) => w.includes("すべて削除")),
);
check(
  "魚拓があれば全滅警告を出さない",
  !warns({
    evidence: [
      {
        url: canonical,
        unavailable_since: "2026-01-02",
        archive_url: "https://web.archive.org/web/1/x",
      },
    ],
  }).some((w) => w.includes("すべて削除")),
);
check(
  "掲載解除の理由なしを警告",
  warns({ status: "delisted" }).some((w) => w.includes("delisted_reason")),
);

// --------------------------------------------------------------------------
// 5. Issue Form の本文の読み取り
// --------------------------------------------------------------------------

// `render: text` を付けた項目は、本文ではコードブロックに包まれて出てくる。
// 囲いを剥がさないと ``` の行をURLとして読んでしまう（issue #2 で発生）
const renderedForm = parseIssueForm(
  [
    "### 対象アカウント",
    "",
    "https://x.com/example",
    "",
    "### 証拠ツイートURL",
    "",
    "```text",
    "https://x.com/example/status/1234567890123456789",
    "https://x.com/example/status/9876543210987654321",
    "```",
    "",
    "### 補足",
    "",
    "_No response_",
  ].join("\n"),
);
eq(
  "render: text のコードブロックを剥がす",
  renderedForm["証拠ツイートURL"].split("\n"),
  [
    "https://x.com/example/status/1234567890123456789",
    "https://x.com/example/status/9876543210987654321",
  ],
);
eq("未記入は空文字", renderedForm["補足"], "");

// 本文の途中に出てくるコードブロックまで壊さない
eq(
  "項目全体を包んでいないコードブロックには触らない",
  parseIssueForm("### 補足\n\n以下のように主張していました:\n\n```\n嘘\n```")[
    "補足"
  ],
  "以下のように主張していました:\n\n```\n嘘\n```",
);

eq(
  "チェックボックスの状態を読む",
  parseCheckboxes("- [X] 読んだ\n- [ ] 含めていない\n- [x] 私怨ではない"),
  [
    { checked: true, label: "読んだ" },
    { checked: false, label: "含めていない" },
    { checked: true, label: "私怨ではない" },
  ],
);
eq("チェックボックスがなければ空", parseCheckboxes("ただの文章"), []);
eq("未記入の確認欄は空", parseCheckboxes(""), []);

// --------------------------------------------------------------------------
// 6. まとめ提出の読み取り
// --------------------------------------------------------------------------
const names = (raw) => parseAccounts(raw).targets.map((t) => t.value);

eq("対象アカウントを行ごとに読む", names("@a\nhttps://x.com/b\nc"), [
  "a",
  "b",
  "c",
]);
eq("箇条書きの印を剥がす", names("- @a\n* @b"), ["a", "b"]);
eq("同じアカウントの重複を畳む", names("@a\nhttps://x.com/A\n@b"), ["a", "b"]);
eq("空行を無視する", names("@a\n\n\n@b"), ["a", "b"]);
eq("未記入は0件", names(""), []);
eq(
  "読めない行だけを分けて返す",
  parseAccounts("@a\n日本語のなまえ\n@b").invalid.map((i) => i.raw),
  ["日本語のなまえ"],
);

eq(
  "証拠URLを行ごとに読む",
  parseEvidence(
    "https://x.com/a/status/1\nhttps://twitter.com/a/status/1?s=20\nhttps://x.com/b/status/2",
  ).tweetIds,
  ["1", "2"],
);
eq(
  "読めない証拠URLを分けて返す",
  parseEvidence("https://x.com/a/status/1\nこれです").unreadable,
  ["これです"],
);

eq("カテゴリを読む", parseCategories("ai-slop, scam\nnope"), [
  "ai-slop",
  "scam",
]);
eq(
  "未チェックのカテゴリを拾わない",
  parseCategories("- [X] ai-slop\n- [ ] scam"),
  ["ai-slop"],
);

// どのアカウントの証拠かは投稿者が決める
const tw = (tweetId, authorId) => ({
  tweetId,
  authorId,
  authorUsername: `u${authorId}`,
});
const grouped = groupEvidence(
  [tw("1", "10"), tw("2", "10"), tw("3", "20"), tw("4", "99")],
  [
    { id: "10", username: "u10" },
    { id: "20", username: "u20" },
    { id: "30", username: "u30" },
  ],
);
eq(
  "投稿者ごとに束ねる",
  [...grouped.byUserId].map(([id, ts]) => [id, ts.length]),
  [
    ["10", 2],
    ["20", 1],
    ["30", 0],
  ],
);
eq(
  "対象外の投稿者を拾う",
  grouped.orphans.map((t) => t.tweetId),
  ["4"],
);
eq(
  "証拠のないアカウントを拾う",
  grouped.empty.map((u) => u.username),
  ["u30"],
);

eq("1件はそのまま", describeAccounts(["@a"]), "@a");
eq("複数件は件数を添える", describeAccounts(["@a", "@b", "@c"]), "@a ほか2件");
eq("0件は空", describeAccounts([]), "");

// --------------------------------------------------------------------------
// 7. ユーザースクリプトと dist/ の契約
// --------------------------------------------------------------------------

// userscript/xgomi.user.js は dist/ を読んで動く。ここが噛み合わなくなる
// 壊れ方は、配ったあとユーザーの画面で初めて分かるので、CIで止める。
// build.mjs が列名や形式を変えたら、このセクションが落ちる。

const userscript = await readFile(
  path.join(ROOT, "userscript/xgomi.user.js"),
  "utf8",
);

// --- 配布物としてのメタデータ ---
const meta = userscript.slice(0, userscript.indexOf("==/UserScript=="));
const metaTable = new Map();
for (const line of meta.split("\n")) {
  const m = /^\/\/ @(\S+)[ \t]+(.+)$/.exec(line.trimEnd());
  if (m) metaTable.set(m[1], m[2].trim());
}
const metaOf = (key) => metaTable.get(key) ?? null;
const RAW =
  "https://raw.githubusercontent.com/mikumiku-jp/xgomi/main/userscript/xgomi.user.js";

check("@version がある", /^\d+\.\d+\.\d+$/.test(metaOf("version") || ""));
// これがないと、更新しても入れた人には一生届かない
eq("@downloadURL が配布場所を指す", metaOf("downloadURL"), RAW);
eq("@updateURL が配布場所を指す", metaOf("updateURL"), RAW);
// @connect * は「どこへでも送れる」宣言。READMEの説明より広い権限は持たせない
check(
  "@connect * を持たない",
  !/^\/\/ @connect\s+\*\s*$/m.test(meta),
  "@connect * は許可範囲が広すぎます",
);
check(
  "既定ソースが dist/ を指す",
  userscript.includes(
    "https://raw.githubusercontent.com/mikumiku-jp/xgomi/main/dist/blocklist.csv",
  ),
);

// --- パーサを切り出す ---
const usLines = userscript.split("\n");
const pStart = usLines.findIndex((l) => /^\s*const RE_ID\s*=/.test(l));
const pEnd = usLines.findIndex((l) =>
  /^\s*const parseText\s*=\s*\(text\)\s*=>\s*parseSource/.test(l),
);
check(
  "パーサを切り出せる",
  pStart >= 0 && pEnd > pStart,
  "userscript の構造が変わりました。この節の切り出し位置を直してください。",
);

if (pStart >= 0 && pEnd > pStart) {
  // 切り出した部分をモジュールとして読み込む。ブラウザAPIに依存しない
  // 純粋な関数なので、Node でそのまま動く。
  const src = `${usLines.slice(pStart, pEnd).join("\n")}\nexport { parseSource };`;
  const { parseSource } = await import(
    `data:text/javascript;base64,${Buffer.from(src, "utf8").toString("base64")}`
  );

  const idsOf = (r) =>
    r.entries
      .filter((e) => e.type === "id")
      .map((e) => e.v)
      .sort();
  const namesOf = (r) => {
    const s = new Set();
    for (const e of r.entries) if (e.type === "name") s.add(e.v);
    for (const e of r.entries)
      if (e.type === "id" && r.map[e.v]) s.add(r.map[e.v].toLowerCase());
    return [...s].sort();
  };
  const dist = (f) => readFile(path.join(ROOT, "dist", f), "utf8");

  // 期待値は dist/blocklist.json から導く。件数を直書きしないので、
  // 掲載が増えてもこのテストは書き換えずに効き続ける。
  let blocklist;
  try {
    blocklist = JSON.parse(await dist("blocklist.json"));
  } catch (e) {
    check("dist/blocklist.json が読める", false, String(e));
    blocklist = { accounts: [] };
  }
  const live = blocklist.accounts.filter((a) => a.status !== "delisted");
  const wantIds = live.map((a) => String(a.id)).sort();
  const wantNames = live.map((a) => a.username.toLowerCase()).sort();

  const csv = parseSource(await dist("blocklist.csv"));
  eq("CSV: idを全件読める", idsOf(csv), wantIds);
  eq("CSV: usernameを全件読める", namesOf(csv), wantNames);
  // 対応表が揃っていれば、ユーザーの画面から x.com への逆引き問い合わせが発生しない
  eq("CSV: 未解決のidが残らない", csv.bare, 0);

  const json = parseSource(await dist("blocklist.json"));
  eq("JSON: idを全件読める", idsOf(json), wantIds);
  eq("JSON: usernameを全件読める", namesOf(json), wantNames);
  eq("JSON: 未解決のidが残らない", json.bare, 0);

  eq(
    "ids.txt: idを全件読める",
    idsOf(parseSource(await dist("ids.txt"))),
    wantIds,
  );
  eq(
    "usernames.txt: usernameを全件読める",
    namesOf(parseSource(await dist("usernames.txt"))),
    wantNames,
  );

  // --- 他所のリストを追加したときの読み取り ---
  const ID = "1646160030352257025";
  const names = (text) => namesOf(parseSource(text));
  const ids = (text) => idsOf(parseSource(text));

  // 2列目が理由やカテゴリのことがある。username と決めつけると、
  // 「1646...,spam」から @spam という無関係のアカウントを消してしまう
  eq("2列目が理由でも巻き込まない", names(`${ID},spam\n`), []);
  eq("2列目が理由でも idは読む", ids(`${ID},spam\n`), [ID]);
  eq("タブ区切りの2列目も同じ", names(`${ID}\tscam\n`), []);
  eq("2列目が数値でも同じ", names(`${ID},42\n`), []);
  // 列名の行を本文として読むと @user_id を消しにいく
  eq("ヘッダ行を本文として読まない", names(`user_id,note\n${ID},spam\n`), []);
  eq("ヘッダ行があってもidは読む", ids(`user_id,note\n${ID},spam\n`), [ID]);
  // 空白区切りは、読めないと1件も拾えず無言で0件になる
  eq("空白区切りのidを読む", ids(`${ID} someuser\n`), [ID]);
  // @ が付いていれば書き手が username だと明示している
  eq("@付きなら対応表に入れる", names(`${ID}, @someuser\n`), ["someuser"]);
  eq("@付きは空白区切りでも入れる", names(`${ID} @someuser\n`), ["someuser"]);
  // 既存の書き方を壊さない
  eq("username: の空白を許す", names("username: someuser\n"), ["someuser"]);
  eq("URLでも読める", names("https://x.com/someuser\n"), ["someuser"]);
  eq("行末コメントを剥がす", ids(`${ID} # こいつ\n`), [ID]);
}

// --------------------------------------------------------------------------
if (failed > 0) {
  console.error(`\n${failed} 件のテストが失敗しました。`);
  process.exit(1);
}
console.log("すべてのテストが通りました。");
