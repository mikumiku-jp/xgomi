#!/usr/bin/env node
// 掲載解除リクエストの下調べをして、判断材料を Markdown で出す。
//
//   ISSUE_BODY="$(cat body.md)" node scripts/removal-triage.mjs
//
// 解除するかどうかは人が決める。ここでやるのは事実の確認だけ:
//   - 該当エントリが存在するか
//   - 証拠ツイートが今も生きているか
//   - 証拠の投稿者が本当にそのIDか（人違いの検出）

import { readFile, readdir } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import path from "node:path";
import {
  tweetById,
  parseTweetUrl,
  classifyAccountInput,
  sleep,
} from "./lib/x.mjs";
import { parseIssueForm } from "./lib/issue-form.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const ACCOUNTS_DIR = path.join(ROOT, "accounts");

const out = [];
const say = (line = "") => out.push(line);

async function loadAccounts() {
  const files = (await readdir(ACCOUNTS_DIR).catch(() => [])).filter((f) =>
    f.endsWith(".json"),
  );
  const list = [];
  for (const f of files) {
    try {
      list.push(JSON.parse(await readFile(path.join(ACCOUNTS_DIR, f), "utf8")));
    } catch {
      // 壊れたファイルは validate が別途弾く
    }
  }
  return list;
}

/** 入力から該当エントリを探す。改名済みでも見つかるよう履歴も見る */
function findAccount(accounts, target) {
  if (target.kind === "numeric-id") {
    return accounts.find((a) => a.id === target.value) ?? null;
  }
  const needle = String(target.value ?? "").toLowerCase();
  return (
    accounts.find((a) => a.id === target.value) ??
    accounts.find((a) => a.username?.toLowerCase() === needle) ??
    accounts.find((a) =>
      (a.username_history ?? []).some((u) => u.toLowerCase() === needle),
    ) ??
    null
  );
}

/** どのエントリの話かをワークフローに渡す（Issue タイトルに使う） */
function emitOutputs(lines) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
}

async function main() {
  const body = process.env.ISSUE_BODY ?? (await readFile(0, "utf8"));
  const s = parseIssueForm(body);
  const rawAccount = s["対象アカウント"] ?? "";
  const reason = s["申請理由"] ?? "(未記入)";

  say("## 自動下調べ");
  say();
  say(`**申請理由**: ${reason}`);
  say();

  const target = classifyAccountInput(rawAccount);
  if (target.kind === "invalid") {
    say(`対象アカウントを解釈できませんでした: \`${rawAccount}\``);
    say(`> ${target.reason}`);
    say();
    say("`@handle` かプロフィールURL、または数値IDを記入してください。");
    return console.log(out.join("\n"));
  }

  // 掲載が見つからなくても、申請対象だけはタイトルに出したい
  emitOutputs([`label=${target.kind === "handle" ? "@" : ""}${target.value}`]);

  const accounts = await loadAccounts();
  const account = findAccount(accounts, target);
  emitOutputs([
    `found=${account ? "true" : "false"}`,
    `id=${account?.id ?? ""}`,
    `username=${account?.username ?? ""}`,
  ]);

  if (!account) {
    say(`\`${rawAccount}\` に該当するエントリは **見つかりませんでした**。`);
    say();
    say("既に掲載解除済みか、そもそも掲載されていない可能性があります。");
    return console.log(out.join("\n"));
  }

  say(
    `対象: \`accounts/${account.id}.json\`（@${account.username}${
      account.status && account.status !== "listed"
        ? ` / status: ${account.status}`
        : ""
    }）`,
  );
  say();
  say(`- カテゴリ: ${(account.categories ?? []).join(", ")}`);
  say(`- 深刻度: ${account.severity ?? "medium"}`);
  say(`- 掲載日: ${account.added_at} / 最終更新: ${account.updated_at}`);
  if ((account.username_history ?? []).length > 0) {
    say(`- 過去のユーザー名: ${account.username_history.join(", ")}`);
  }
  say();

  // --- 証拠の確認 ---
  say("### 証拠の状態");
  say();
  let alive = 0;
  let mismatched = 0;
  let archived = 0;

  for (const ev of account.evidence ?? []) {
    const parsed = parseTweetUrl(ev?.url ?? "");
    if (!parsed) {
      say(`- ⚠ \`${ev?.url}\`：URLとして解釈できません`);
      continue;
    }
    const tweet = await tweetById(parsed.tweetId).catch(() => null);
    await sleep(400);

    const hasArchive = Boolean(ev.archive_url);
    if (hasArchive) archived++;
    const archiveNote = hasArchive ? ` / [魚拓](${ev.archive_url})` : "";

    if (!tweet) {
      say(`- 🗑 ${ev.url}：削除済み${archiveNote}`);
    } else if (tweet.authorId === account.id) {
      alive++;
      say(`- ✅ ${ev.url}：本人の投稿として健在${archiveNote}`);
    } else {
      mismatched++;
      say(
        `- ❌ ${ev.url}：**投稿者が別人** (@${tweet.authorUsername} / id=${tweet.authorId})${archiveNote}`,
      );
    }
  }

  const total = (account.evidence ?? []).length;
  say();
  say("### 判断材料");
  say();

  if (mismatched > 0) {
    say(
      `- ❌ 証拠 ${mismatched}/${total} 件の投稿者が、このエントリのIDと一致しません。**人違いの可能性が高く、掲載解除が妥当です。**`,
    );
  }
  if (alive === 0 && total > 0) {
    if (archived > 0) {
      say(
        `- 🗑 証拠の投稿はすべて削除されていますが、魚拓が ${archived} 件残っています。「削除して継続していない」なら POLICY 上は掲載解除の対象です。`,
      );
    } else {
      say(
        "- 🗑 証拠の投稿はすべて削除され、魚拓もありません。**掲載の妥当性を誰も検証できないため、掲載解除が妥当です。**",
      );
    }
  }
  if (alive > 0 && mismatched === 0) {
    say(
      `- ✅ 本人の投稿として健在な証拠が ${alive}/${total} 件あります。掲載の根拠は現時点で残っています。`,
    );
    say(
      "- 「該当投稿を削除し継続していない」ことを理由とする申請の場合、該当投稿がまだ残っている点を申請者に確認してください。",
    );
  }
  say();
  say(
    "> これは自動で集めた事実の一覧です。解除するかどうかは POLICY.md に照らして人が判断します。",
  );

  console.log(out.join("\n"));
}

main().catch((e) => {
  console.log(`## 自動下調べ\n\n下調べ中にエラーが発生しました: ${e.message}`);
});
