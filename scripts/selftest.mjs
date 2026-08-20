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
  eq(`parseTweetUrl(${JSON.stringify(input)})`, parseTweetUrl(input)?.canonical ?? null, expected);
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
  eq(`classifyAccountInput(${JSON.stringify(input)})`, [c.kind, c.value], [
    kind,
    value,
  ]);
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
check("ファイル名の不一致を弾く", validateAccount(base, { filename: "13.json" }).errors.length === 1);
check("未知のカテゴリを弾く", errs({ categories: ["nope"] }).length > 0);
check("カテゴリ空を弾く", errs({ categories: [] }).length > 0);
check("カテゴリ重複を弾く", errs({ categories: ["ai-slop", "ai-slop"] }).length > 0);
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
check("15文字超のusernameを弾く", errs({ username: "a".repeat(16) }).length > 0);
check("不正なstatusを弾く", errs({ status: "unknown" }).length > 0);
check("メールアドレスを弾く", errs({ note: "連絡先 foo@example.com" }).length > 0);
check("電話番号を弾く", errs({ note: "090-1234-5678" }).length > 0);
check(
  "unavailable_since の形式を弾く",
  errs({ evidence: [{ url: canonical, unavailable_since: "きのう" }] }).length > 0,
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
if (failed > 0) {
  console.error(`\n${failed} 件のテストが失敗しました。`);
  process.exit(1);
}
console.log("すべてのテストが通りました。");
