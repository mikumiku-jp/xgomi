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
//   5. あわせて証拠の生死を記録し、魚拓のないものはここで拼う

import { readFile, readdir, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import path from "node:path";
import {
  userByScreenName,
  tweetById,
  parseTweetUrl,
  archiveUrl,
  waybackLookup,
  today,
  sleep,
} from "./lib/x.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const ACCOUNTS_DIR = path.join(ROOT, "accounts");

/**
 * 証拠ツイートを一通り見て、生死を data に書き込む。
 * ついでに現在のハンドルを復元し、魚拓のないものを拼う。
 */
async function auditEvidence(data) {
  let recovered = null;
  let alive = 0;
  const died = [];
  const revived = [];
  const archived = [];

  for (const ev of data.evidence ?? []) {
    const parsed = parseTweetUrl(ev?.url ?? "");
    if (!parsed) continue;

    const tweet = await tweetById(parsed.tweetId).catch(() => null);
    await sleep(400);

    if (tweet) {
      alive++;
      if (ev.unavailable_since) {
        delete ev.unavailable_since;
        revived.push(ev.url);
      }
      if (!recovered && tweet.authorId === data.id && tweet.authorUsername) {
        recovered = tweet.authorUsername;
      }
      if (!ev.archive_url) {
        const a = await archiveUrl(ev.url);
        if (a) {
          ev.archive_url = a;
          archived.push(ev.url);
        }
      }
    } else {
      if (!ev.unavailable_since) {
        ev.unavailable_since = today();
        died.push(ev.url);
      }
      // 消された後でも、過去に取られた魚拓が見つかることがある
      if (!ev.archive_url) {
        const a = await waybackLookup(ev.url);
        if (a) {
          ev.archive_url = a;
          archived.push(ev.url);
        }
      }
    }
  }
  return { recovered, alive, died, revived, archived };
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

    // 証拠の生死は毎回見る。「掲載されたら全部消して逃げる」を拾うため
    const audit = await auditEvidence(data);

    if (resolved && resolved.id === data.id) {
      // 健在。表示名の変化だけ拾う
      data.status = "listed";
      if (resolved.displayName && resolved.displayName !== data.display_name) {
        data.display_name = resolved.displayName;
      }
    } else {
      const recovered = audit.recovered;

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

    // 証拠の変化を報告する
    if (audit.died.length > 0) {
      changes.push(
        `🗑 id=${data.id} (@${data.username}): 証拠 ${audit.died.length} 件が削除されました。`,
      );
    }
    if (audit.archived.length > 0) {
      changes.push(
        `📚 id=${data.id} (@${data.username}): 魚拓を ${audit.archived.length} 件確保しました。`,
      );
    }
    const verifiable = (data.evidence ?? []).filter(
      (e) => !e.unavailable_since || e.archive_url,
    );
    if (verifiable.length === 0 && (data.evidence ?? []).length > 0) {
      changes.push(
        `❗ id=${data.id} (@${data.username}): 証拠がすべて消え、魚拓もありません。掲載を続けるか人間の判断が必要です。`,
      );
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
