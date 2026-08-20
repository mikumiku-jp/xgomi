# xgomi

AI生成スパム・AI驚き屋アカウントの、コミュニティ管理によるブロックリスト。

自分のタイムラインを自分で整えるためのデータセットです。
Issue を送るだけで登録でき、あとは CI が数値ID の解決・証拠の照合・配布ファイルの生成まで自動でやります。

> [!IMPORTANT]
> 掲載には **検証可能な証拠ツイートが必須** です。
> 掲載基準・禁止事項・異議申立ての方法は [POLICY.md](POLICY.md) を必ず読んでください。

## 使う

`dist/` の配布ファイルを直接読み込めます。

| ファイル | 用途 |
| --- | --- |
| [`dist/ids.txt`](dist/ids.txt) | 数値IDのみ。**改名に強いので推奨** |
| [`dist/usernames.txt`](dist/usernames.txt) | 現在の @handle のみ |
| [`dist/blocklist.json`](dist/blocklist.json) | 証拠・カテゴリを含む全データ |
| [`dist/blocklist.csv`](dist/blocklist.csv) | 表計算・各種ツール向け |
| [`dist/stats.json`](dist/stats.json) | 件数の統計 |

```bash
# 数値IDの一覧を取得
curl -sL https://raw.githubusercontent.com/mikumiku-jp/xgomi/main/dist/ids.txt

# scam カテゴリだけ抽出
curl -sL https://raw.githubusercontent.com/mikumiku-jp/xgomi/main/dist/blocklist.json \
  | jq -r '.accounts[] | select(.categories | index("scam")) | .username'
```

## 登録する

[**アカウントを報告する**](../../issues/new?template=report.yml) から Issue を送ってください。
必要なのは以下の3つだけです。

1. 対象アカウント（`@handle` または プロフィールURL）
2. カテゴリ（[POLICY.md](POLICY.md) の定義から選択）
3. 証拠ツイートのURL（1件以上）

Issue を送ると、GitHub Actions が自動で:

1. `@handle` から **数値ID (`rest_id`)** を解決
2. 証拠ツイートを取得し、**投稿者が本当にその人か照合**（人違い・URL貼り間違いをここで弾く）
3. `accounts/<数値ID>.json` を生成して **PR を自動作成**

検証に失敗した場合は、理由が Issue にコメントされます。
手動で PR を送ることもできます → [CONTRIBUTING.md](CONTRIBUTING.md)

## なぜ username ではなく数値ID なのか

`@handle` はいつでも変更できます。数値ID (`rest_id`) はアカウント削除まで変わりません。
username だけで管理すると、改名した時点で追跡できなくなり、
さらに **手放された古いハンドルを取得した無関係の第三者** を巻き込む事故が起きます。

そのため、このリポジトリでは:

- **主キーは数値ID** — ファイル名も `accounts/<数値ID>.json`
- `username` はあくまで登録時点のスナップショット
- 改名を検知したら `username_history` に退避して自動追記

改名の検知は、証拠ツイートを利用しています。
X のツイート取得エンドポイントは投稿者の **現在の** ハンドルを返すため、
「数値ID → 現在の username」の逆引きとして機能します。
これを毎日実行し、改名・凍結を自動で追跡します。

## データ構造

```jsonc
// accounts/1234567890.json
{
  "$schema": "../schema/account.schema.json",
  "id": "1234567890",              // 数値ID。不変。ファイル名と一致
  "username": "example",           // 登録/最終確認時点のハンドル
  "display_name": "Example",
  "categories": ["ai-hype"],       // POLICY.md の定義に対応
  "severity": "medium",            // low / medium / high
  "evidence": [                    // 1件以上必須。投稿者IDをCIが照合
    {
      "url": "https://x.com/example/status/1234567890123456789",
      "note": "存在しない機能を「実装した」と主張",
      "archive_url": "https://web.archive.org/..."   // 削除対策に推奨
    }
  ],
  "status": "listed",              // listed / username-changed / suspended / deleted / delisted
  "username_history": [],          // 改名を検知すると自動追記
  "added_at": "2026-02-11",
  "updated_at": "2026-02-11"
}
```

1アカウント = 1ファイルにしているため、PR 同士がコンフリクトしません。
`dist/` は `accounts/` から CI が自動生成するので、手で編集しないでください。

## ローカルでの実行

依存パッケージはありません。Node.js 18 以降のみ必要です。

```bash
node scripts/validate.mjs              # 形式チェック（オフライン）
node scripts/validate.mjs --network    # 証拠ツイートの投稿者IDまで照合
node scripts/build.mjs                 # dist/ を生成
node scripts/refresh.mjs               # 改名・凍結を追跡して accounts/ を更新
```

## 自動化

| ワークフロー | 契機 | 動作 |
| --- | --- | --- |
| `validate.yml` | PR | 変更されたエントリを検証（証拠の投稿者照合を含む） |
| `issue-to-pr.yml` | Issue に `report` ラベル | Issue を JSON 化して PR を自動作成 |
| `build.yml` | main への push | `dist/` を再生成してコミット |
| `refresh.yml` | 毎日 / 手動 | 改名・凍結を検知して PR を作成 |

## ライセンス

データ（`accounts/`, `dist/`）は [CC0-1.0](LICENSE)。
スクリプト（`scripts/`）は MIT。

## 免責

掲載は各投稿の内容についての評価であり、人物の否定ではありません。
誤りがあれば [掲載解除リクエスト](../../issues/new?template=removal.yml) から申請してください。
このデータを嫌がらせ・通報の呼びかけに使うことは [POLICY.md](POLICY.md) で明確に禁止しています。
