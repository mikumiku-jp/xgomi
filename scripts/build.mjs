#!/usr/bin/env node
// accounts/*.json から dist/ の配布用ファイルを生成する。

import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const ACCOUNTS_DIR = path.join(ROOT, "accounts");
const DIST_DIR = path.join(ROOT, "dist");

const csvEscape = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

async function main() {
  const files = (await readdir(ACCOUNTS_DIR).catch(() => []))
    .filter((f) => f.endsWith(".json"))
    .sort();

  const accounts = [];
  for (const f of files) {
    const raw = await readFile(path.join(ACCOUNTS_DIR, f), "utf8");
    try {
      accounts.push(JSON.parse(raw));
    } catch (e) {
      throw new Error(`accounts/${f} を JSON として読めません: ${e.message}`, {
        cause: e,
      });
    }
  }

  // 掲載解除されたものは配布対象から外す（リポジトリには履歴として残る）
  // $schema はエディタ補完用の内部フィールドなので配布物からは除く
  const active = accounts
    .filter((a) => a.status !== "delisted")
    .map(({ $schema, ...rest }) => rest)
    .map((a) => {
      // 手放したハンドルは別人が取得できる。本人のものだと確認できない
      // ハンドルを配布物に残すと、それを読んだツールが無関係の人をブロックする。
      if (a.status !== "username-changed") return a;
      const history = new Set(a.username_history ?? []);
      history.add(a.username);
      return { ...a, username: null, username_history: [...history] };
    });
  active.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));

  await mkdir(DIST_DIR, { recursive: true });

  const generatedAt = new Date().toISOString();
  const meta = {
    name: "xgomi",
    description: "AI生成スパム・AI驚き屋アカウントのコミュニティ管理リスト",
    homepage: "https://github.com/mikumiku-jp/xgomi",
    license: "CC0-1.0",
    generated_at: generatedAt,
    count: active.length,
  };

  // 1) 完全なデータ
  await writeFile(
    path.join(DIST_DIR, "blocklist.json"),
    `${JSON.stringify({ ...meta, accounts: active }, null, 2)}\n`,
  );

  // 2) 数値IDのみ（改名に強い＝推奨）
  await writeFile(
    path.join(DIST_DIR, "ids.txt"),
    active.map((a) => a.id).join("\n") + (active.length ? "\n" : ""),
  );

  // 3) 現在のハンドルのみ
  //    本人のものだと確認できているハンドルだけを出す。
  //    改名後のハンドルは別人が取得していることがあり、
  //    そのまま配布すると無関係の人がブロックされる。
  const nameSafe = active.filter(
    (a) => (a.status ?? "listed") === "listed" && a.username,
  );
  await writeFile(
    path.join(DIST_DIR, "usernames.txt"),
    nameSafe.map((a) => a.username).join("\n") + (nameSafe.length ? "\n" : ""),
  );

  // 4) 表計算・各種ツール向け
  const header =
    "id,username,categories,severity,status,evidence_count,added_at,updated_at";
  const rows = active.map((a) =>
    [
      a.id,
      a.username ?? "",
      (a.categories ?? []).join("|"),
      a.severity ?? "medium",
      a.status ?? "listed",
      (a.evidence ?? []).length,
      a.added_at,
      a.updated_at,
    ]
      .map(csvEscape)
      .join(","),
  );
  await writeFile(
    path.join(DIST_DIR, "blocklist.csv"),
    [header, ...rows].join("\n") + "\n",
  );

  // 5) 統計
  const byCategory = {};
  const bySeverity = {};
  for (const a of active) {
    for (const c of a.categories ?? [])
      byCategory[c] = (byCategory[c] ?? 0) + 1;
    const s = a.severity ?? "medium";
    bySeverity[s] = (bySeverity[s] ?? 0) + 1;
  }
  await writeFile(
    path.join(DIST_DIR, "stats.json"),
    `${JSON.stringify(
      {
        generated_at: generatedAt,
        total: active.length,
        delisted: accounts.length - active.length,
        evidence_total: active.reduce(
          (n, a) => n + (a.evidence ?? []).length,
          0,
        ),
        distributable_usernames: nameSafe.length,
        by_category: byCategory,
        by_severity: bySeverity,
      },
      null,
      2,
    )}\n`,
  );

  console.log(
    `dist/ を生成しました: ${active.length} 件（掲載解除 ${accounts.length - active.length} 件を除外）`,
  );
}

await main();
