#!/usr/bin/env node
// 定期実行して各アカウントの現状を追跡する。
//
//   node scripts/refresh.mjs
//
// 追跡ロジック:
//   1. 記録済み username を引く → 同じ id が返れば健在
//   2. 別 id が返る / 解決できない → 改名 or 凍結の疑い
//   3. 証拠ツイートを引く（tweet-result は「現在の」ハンドルを返す）
//      → 投稿者 id が一致すれば、そこから新しい username を復元する
//   4. 何も辿れなければ suspended として印を付け、人間のレビューに回す

import { readFile, readdir, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import path from "node:path";
import {
  userByScreenName,
  tweetById,
  parseTweetUrl,
  today,
  sleep,
} from "./lib/x.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const ACCOUNTS_DIR = path.join(ROOT, "accounts");

/** 生きている証拠ツイートから現在のハンドルを復元する */
async function recoverUsernameFromEvidence(data) {
  for (const ev of data.evidence ?? []) {
    const parsed = parseTweetUrl(ev?.url ?? "");
    if (!parsed) continue;

    const tweet = await tweetById(parsed.tweetId).catch(() => null);
    await sleep(500);
    if (tweet?.authorId === data.id && tweet.authorUsername) {
      return tweet.authorUsername;
    }
  }
  return null;
}

async function main() {
  const files = (await readdir(ACCOUNTS_DIR).catch(() => []))
    .filter((f) => f.endsWith(".json"))
    .sort();

  const changes = [];
  let checked = 0;

  for (const f of files) {
    const filePath = path.join(ACCOUNTS_DIR, f);
    const raw = await readFile(filePath, "utf8");
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.error(`✖ accounts/${f}: JSON として読めません (${e.message})`);
      continue;
    }
    if (data.status === "delisted") continue;

    checked++;
    const before = JSON.stringify(data);
    const prevUsername = data.username;
    const prevStatus = data.status ?? "listed";

    let resolved = null;
    try {
      resolved = await userByScreenName(data.username);
    } catch (e) {
      console.error(
        `⚠ @${data.username}: 照会に失敗 (${e.message})。スキップします。`,
      );
      continue;
    }
    await sleep(700);

    if (resolved && resolved.id === data.id) {
      // 健在。表示名の変化だけ拾う
      data.status = "listed";
      if (resolved.displayName && resolved.displayName !== data.display_name) {
        data.display_name = resolved.displayName;
      }
    } else {
      // ハンドルが本人のものでなくなった → 証拠ツイートから復元を試みる
      const recovered = await recoverUsernameFromEvidence(data);

      if (
        recovered &&
        recovered.toLowerCase() !== data.username.toLowerCase()
      ) {
        const history = new Set(data.username_history ?? []);
        history.add(data.username);
        data.username_history = [...history];
        data.username = recovered;
        data.status = "listed";
        changes.push(
          `🔄 id=${data.id}: @${prevUsername} → @${recovered}（改名を検知）`,
        );
      } else if (recovered) {
        data.status = "listed";
      } else if (resolved) {
        // 記録しているハンドルが別人のものになっている。
        // 現在のハンドルは不明なので、このハンドルを配布し続けると
        // 無関係の人がブロックされる。
        const history = new Set(data.username_history ?? []);
        history.add(data.username);
        data.username_history = [...history];
        data.status = "username-changed";
        if (prevStatus !== "username-changed") {
          changes.push(
            `⚠ id=${data.id}: @${prevUsername} は別人 (id=${resolved.id}) のアカウントになっています。現在のハンドルは不明のため、ユーザー名の配布を停止しました。`,
          );
        }
      } else {
        data.status = "suspended";
        if (prevStatus !== "suspended") {
          changes.push(
            `🚫 id=${data.id} (@${data.username}): 凍結/削除の疑い。証拠ツイートも辿れません。`,
          );
        }
      }
    }

    data.last_checked_at = today();
    if (JSON.stringify(data) !== before) {
      if (data.username !== prevUsername || data.status !== prevStatus) {
        data.updated_at = today();
      }
      await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
    }
  }

  console.log(`${checked} 件を確認しました。`);
  if (changes.length > 0) {
    console.log("\n変更点:");
    for (const c of changes) console.log(`  ${c}`);
  } else {
    console.log("状態の変化はありませんでした。");
  }

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `checked=${checked}`,
        `change_count=${changes.length}`,
        `summary<<XGOMI_EOF`,
        changes.length > 0
          ? changes.join("\n")
          : "状態の変化はありませんでした。",
        `XGOMI_EOF`,
      ].join("\n") + "\n",
    );
  }
}

await main();
