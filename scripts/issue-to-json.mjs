#!/usr/bin/env node
// GitHub Issue Form の本文を accounts/<id>.json に変換する。
// 対象アカウントは複数書ける。証拠ツイートは投稿者ごとに振り分ける。
//
//   ISSUE_BODY="$(cat body.md)" node scripts/issue-to-json.mjs
//
// 成功時: accounts/<id>.json を書き出し、GITHUB_OUTPUT に件数と一覧を出力
// 失敗時: 標準エラーに理由を出して exit 1（呼び出し元が Issue にコメントする）
// どちらでも label を出力する（呼び出し元が Issue タイトルに使う）

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { appendFileSync } from "node:fs";
import {
  userByScreenName,
  tweetById,
  parseTweetUrl,
  archiveUrl,
  today,
  sleep,
} from "./lib/x.mjs";
import { validateAccount, CATEGORIES } from "./lib/validate-core.mjs";
import { parseIssueForm, parseCheckboxes } from "./lib/issue-form.mjs";
import {
  parseAccounts,
  parseCategories,
  parseEvidence,
  groupEvidence,
  describeAccounts,
  MAX_ACCOUNTS,
} from "./lib/report-input.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const ACCOUNTS_DIR = path.join(ROOT, "accounts");

// 魚拓は1件あたり最長60秒かかる。件数が増えても全体が伸びきらないよう頭を打つ。
// 魚拓は必須ではないので、打ち切っても報告自体は通す。
const ARCHIVE_BUDGET_MS = 5 * 60 * 1000;

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const emitOutput = (lines) => {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
};

const emitMultiline = (key, value) => {
  emitOutput([`${key}<<XGOMI_EOF`, value, "XGOMI_EOF"]);
};

/**
 * 入力から対象アカウントを確定する。
 * 数値IDでは直接引けないので、取得済みの証拠ツイートの投稿者から逆引きする。
 */
async function resolveTarget(target, tweets) {
  const byHandle = async (handle) => {
    const u = await userByScreenName(handle).catch((e) =>
      fail(
        `X への問い合わせに失敗しました: ${e.message}\n時間をおいて再度お試しください。`,
      ),
    );
    return u;
  };

  const byNumericId = async () => {
    const t = tweets.find((x) => x.authorId === target.value);
    if (!t?.authorUsername) return null;
    const u = await byHandle(t.authorUsername);
    return u && u.id === target.value ? u : null;
  };

  if (target.kind === "handle") {
    const u = await byHandle(target.value);
    if (!u) {
      fail(
        `\`@${target.value}\` を見つけられませんでした。凍結、改名、削除、または綴り間違いの可能性があります。`,
      );
    }
    return u;
  }

  if (target.kind === "numeric-id") {
    const u = await byNumericId();
    if (!u) {
      fail(
        `数値ID \`${target.value}\` の現在のユーザー名を特定できませんでした。\n記入した証拠ツイートがこのIDの投稿ではないか、削除されています。対象アカウントには \`@username\` を記入してください。`,
      );
    }
    return u;
  }

  // ambiguous: 数字だけの短い入力。ユーザー名としても数値IDとしても読める
  const asHandle = await byHandle(target.value);
  if (asHandle) return asHandle;
  const asId = await byNumericId();
  if (asId) return asId;
  fail(
    `\`${target.value}\` はユーザー名としても数値IDとしても見つかりませんでした。対象アカウントには \`@username\` を記入してください。`,
  );
}

/** 1アカウント分のエントリを組み立てて書き出す */
async function writeEntry({
  user,
  tweets,
  categories,
  note,
  overwriteNote,
  deadline,
}) {
  const evidence = [];
  for (const t of tweets) {
    const url = `https://x.com/${t.authorUsername}/status/${t.tweetId}`;
    const archived = Date.now() < deadline ? await archiveUrl(url) : null;
    evidence.push(archived ? { url, archive_url: archived } : { url });
  }

  const filePath = path.join(ACCOUNTS_DIR, `${user.id}.json`);
  const isNew = !existsSync(filePath);
  let existing = null;
  if (!isNew) {
    const raw = await readFile(filePath, "utf8");
    try {
      existing = JSON.parse(raw);
    } catch (e) {
      fail(
        `@${user.username} の既存の掲載データを読み込めませんでした。メンテナの対応が必要です。(${e.message})`,
      );
    }
  }

  // まとめ提出の補足は全件で共通なので、個別に書かれた既存の補足を潰さない
  const finalNote = overwriteNote
    ? note || existing?.note
    : existing?.note || note;

  const usernameHistory = new Set(existing?.username_history ?? []);
  if (existing && existing.username !== user.username)
    usernameHistory.add(existing.username);

  const mergedEvidence = [...(existing?.evidence ?? [])];
  for (const ev of evidence) {
    const id = parseTweetUrl(ev.url).tweetId;
    if (
      !mergedEvidence.some((e) => parseTweetUrl(e.url ?? "")?.tweetId === id)
    ) {
      mergedEvidence.push(ev);
    }
  }

  const data = {
    $schema: "../schema/account.schema.json",
    id: user.id,
    username: user.username,
    ...(user.displayName ? { display_name: user.displayName } : {}),
    categories: [...new Set([...(existing?.categories ?? []), ...categories])],
    severity: existing?.severity ?? "medium",
    evidence: mergedEvidence,
    ...(finalNote ? { note: finalNote } : {}),
    status: existing?.status ?? "listed",
    ...(usernameHistory.size > 0
      ? { username_history: [...usernameHistory] }
      : {}),
    added_at: existing?.added_at ?? today(),
    updated_at: today(),
  };

  const { errors } = validateAccount(data, { filename: `${user.id}.json` });
  if (errors.length > 0) {
    fail(
      `@${user.username} の内容に問題があります:\n${errors.map((e) => `- ${e}`).join("\n")}`,
    );
  }

  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
  return { user, isNew, evidenceCount: mergedEvidence.length };
}

async function main() {
  const body = process.env.ISSUE_BODY ?? (await readFile(0, "utf8"));
  if (!body.trim()) fail("Issue 本文が空です。");

  const s = parseIssueForm(body);

  // --- 確認欄 ---
  // フォーム送信時にしか効かないので、ここでも見る。
  // 送信後に本文を編集してチェックを外す / フォームを通さず立てる、が塞げる。
  const confirms = parseCheckboxes(s["確認"] ?? "");
  if (confirms.length === 0) {
    fail(
      "確認欄がありません。報告フォームから作成してください:\nhttps://github.com/mikumiku-jp/xgomi/issues/new?template=1-report.yml",
    );
  }
  const unchecked = confirms.filter((c) => !c.checked);
  if (unchecked.length > 0) {
    fail(
      `確認欄にチェックが入っていない項目があります:\n${unchecked.map((c) => `- ${c.label}`).join("\n")}\n\nすべての項目に同意できない報告は受け付けていません。`,
    );
  }

  // --- 対象アカウント ---
  const { targets, invalid } = parseAccounts(s["対象アカウント"] ?? "");
  if (invalid.length > 0) {
    fail(
      `対象アカウントを解釈できませんでした:\n${invalid.map((i) => `- \`${i.raw}\`：${i.reason}`).join("\n")}\n\n1行に1件、\`@username\` または \`https://x.com/username\` の形式で記入してください。`,
    );
  }
  if (targets.length === 0) fail("対象アカウントが記入されていません。");
  if (targets.length > MAX_ACCOUNTS) {
    fail(
      `1つの Issue でまとめて報告できるのは ${MAX_ACCOUNTS} 件までです（${targets.length} 件ありました）。分けて報告してください。`,
    );
  }

  // この先で失敗しても、何の報告かはタイトルに出したい
  emitOutput([
    `label=${describeAccounts(
      targets.map((t) => (t.kind === "handle" ? `@${t.value}` : t.value)),
    )}`,
  ]);

  // --- カテゴリ ---
  const categories = parseCategories(s["カテゴリ"] ?? "");
  if (categories.length === 0) {
    fail(
      `カテゴリが選択されていないか、未知の値です。有効なカテゴリ: ${CATEGORIES.join(", ")}`,
    );
  }

  // --- 証拠 ---
  const { tweetIds, unreadable } = parseEvidence(s["証拠ツイートURL"] ?? "");
  if (unreadable.length > 0) {
    fail(
      `証拠ツイートURLのうち ${unreadable.length} 行を読み取れませんでした:\n${unreadable.map((u) => `- ${u}`).join("\n")}\n\n1行に1件、https://x.com/<ユーザー名>/status/<数字> の形式で記入してください。`,
    );
  }
  if (tweetIds.length === 0) fail("証拠ツイートURLが1件も記入されていません。");

  // --- 証拠ツイートを取得 ---
  const tweets = [];
  const missing = [];
  for (const tweetId of tweetIds) {
    const t = await tweetById(tweetId).catch(() => null);
    await sleep(400);
    if (t) tweets.push({ ...t, tweetId });
    else missing.push(tweetId);
  }
  // 1件でも通らなければ報告全体を差し戻す。一部だけ採用すると、報告者が
  // 挙げたつもりの根拠と掲載内容が食い違う。
  if (missing.length > 0) {
    fail(
      `証拠ツイート ${missing.length} 件を取得できません（削除済み、非公開、凍結のいずれか）:\n${missing.map((id) => `- https://x.com/i/status/${id}`).join("\n")}\n\n該当の行を取り除くか、正しいURLに直して本文を編集してください。\n削除済みの投稿を根拠にしたい場合は、魚拓URLを添えて手動でPRを送ってください（CONTRIBUTING.md）。`,
    );
  }

  // --- 対象アカウントを確定 ---
  const users = [];
  for (const target of targets) {
    const user = await resolveTarget(target, tweets);
    if (user.protected) {
      fail(
        `\`@${user.username}\` は鍵アカウントです。第三者が内容を検証できないため、掲載対象外です（POLICY.md）。`,
      );
    }
    // ハンドルと数値IDで同じアカウントを二重に書いていることがある
    if (!users.some((u) => u.id === user.id)) users.push(user);
    await sleep(400);
  }

  // --- 証拠を投稿者ごとに束ねる ---
  const { byUserId, orphans, empty } = groupEvidence(tweets, users);
  if (empty.length > 0) {
    fail(
      `次のアカウントは証拠ツイートが1件もありません:\n${empty.map((u) => `- @${u.username}`).join("\n")}\n\n対象アカウント1件につき、そのアカウント本人の投稿を最低1件挙げてください。`,
    );
  }
  if (orphans.length > 0) {
    fail(
      `次の証拠ツイートは、対象アカウントに挙げていない人の投稿です:\n${orphans.map((t) => `- https://x.com/${t.authorUsername}/status/${t.tweetId}：投稿者が @${t.authorUsername} です`).join("\n")}\n\n対象アカウント欄に足すか、その行を取り除いてください。`,
    );
  }

  // --- 書き出し ---
  await mkdir(ACCOUNTS_DIR, { recursive: true });
  const note = (s["補足"] ?? "").slice(0, 1000);
  const deadline = Date.now() + ARCHIVE_BUDGET_MS;
  const results = [];
  for (const user of users) {
    results.push(
      await writeEntry({
        user,
        tweets: byUserId.get(user.id),
        categories,
        note,
        overwriteNote: users.length === 1,
        deadline,
      }),
    );
  }

  const newCount = results.filter((r) => r.isNew).length;
  const updateCount = results.length - newCount;
  let subject;
  if (results.length === 1) {
    const [r] = results;
    subject = `${r.isNew ? "追加" : "更新"}: @${r.user.username} (id=${r.user.id})`;
  } else {
    subject = [
      newCount > 0 ? `追加${newCount}件` : "",
      updateCount > 0 ? `更新${updateCount}件` : "",
    ]
      .filter(Boolean)
      .join("と");
  }

  console.log(
    results
      .map(
        (r) =>
          `id=${r.user.id} username=${r.user.username} created=${r.isNew} evidence=${r.evidenceCount}`,
      )
      .join("\n"),
  );

  emitOutput([
    `count=${results.length}`,
    `files=${results.map((r) => `accounts/${r.user.id}.json`).join(" ")}`,
    `subject=${subject}`,
    `issue_title=${describeAccounts(
      results.map((r) => `@${r.user.username} (id=${r.user.id})`),
    )}`,
  ]);
  emitMultiline(
    "rows",
    results
      .map(
        (r) =>
          `| @${r.user.username} | \`${r.user.id}\` | ${r.evidenceCount} | ${r.isNew ? "新規" : "更新"} |`,
      )
      .join("\n"),
  );
}

await main();
