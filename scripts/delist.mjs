#!/usr/bin/env node
// エントリを掲載解除する。
//
//   DELIST_TARGET="@example" DELIST_REASON="人違い" node scripts/delist.mjs
//
// ファイルは消さずに status を delisted にする。
// 削除してしまうと「なぜ解除したのか」が追えなくなり、同じ報告が繰り返される。

import { readFile, readdir, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { classifyAccountInput, today } from "./lib/x.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const ACCOUNTS_DIR = path.join(ROOT, "accounts");

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

async function main() {
  const rawTarget = process.env.DELIST_TARGET ?? "";
  const reason = (process.env.DELIST_REASON ?? "").trim();

  if (!rawTarget.trim()) fail("対象アカウントが指定されていません。");
  if (!reason) {
    fail(
      "解除理由が指定されていません。`/delist @example 人違いのため` のように理由を書いてください。",
    );
  }
  if (reason.length > 300) {
    fail(`解除理由が長すぎます（${reason.length}文字）。300文字以内にしてください。`);
  }

  const target = classifyAccountInput(rawTarget);
  if (target.kind === "invalid") {
    fail(`対象アカウントを解釈できませんでした: \`${rawTarget}\`\n${target.reason}`);
  }

  const files = (await readdir(ACCOUNTS_DIR).catch(() => [])).filter((f) =>
    f.endsWith(".json"),
  );

  const needle = String(target.value ?? "").toLowerCase();
  let hit = null;

  for (const f of files) {
    const filePath = path.join(ACCOUNTS_DIR, f);
    let data;
    try {
      data = JSON.parse(await readFile(filePath, "utf8"));
    } catch {
      continue;
    }
    const matches =
      data.id === target.value ||
      data.username?.toLowerCase() === needle ||
      (data.username_history ?? []).some((u) => u.toLowerCase() === needle);
    if (matches) {
      hit = { filePath, data };
      break;
    }
  }

  if (!hit) {
    fail(
      `\`${rawTarget}\` に該当するエントリが見つかりませんでした。既に解除済みか、掲載されていません。`,
    );
  }

  if (hit.data.status === "delisted") {
    fail(
      `\`accounts/${hit.data.id}.json\` は既に掲載解除されています（理由: ${hit.data.delisted_reason ?? "記録なし"}）。`,
    );
  }

  hit.data.status = "delisted";
  hit.data.delisted_reason = reason;
  hit.data.updated_at = today();

  await writeFile(hit.filePath, `${JSON.stringify(hit.data, null, 2)}\n`);

  console.log(
    `accounts/${hit.data.id}.json（@${hit.data.username}）を掲載解除しました。`,
  );

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `id=${hit.data.id}`,
        `username=${hit.data.username ?? ""}`,
        `reason=${reason.replace(/\r?\n/g, " ")}`,
      ].join("\n") + "\n",
    );
  }
}

main().catch((e) => fail(`予期しないエラー: ${e.message}`));
