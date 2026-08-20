# xgomi

X のゴミ垢ブロックリスト。AI驚き屋、無断転載まとめアフィ、情報商材、インプレ稼ぎ、bot——種類は問いません。

自分のタイムラインを自分で整えるためのデータセットです。
Issue を1本送れば、あとは数値IDの解決・証拠の照合・PR作成まで自動で進みます。

> [!IMPORTANT]
> 掲載には **検証可能な証拠ツイートが必須** です。
> 掲載基準・禁止事項・異議申立ての方法は [POLICY.md](POLICY.md) を読んでください。

## 使う

`dist/` を直接読み込めます。

| ファイル | 用途 |
| --- | --- |
| [`dist/ids.txt`](dist/ids.txt) | 数値IDのみ。**改名に強いので推奨** |
| [`dist/usernames.txt`](dist/usernames.txt) | 現在の @handle のみ |
| [`dist/blocklist.json`](dist/blocklist.json) | 証拠・カテゴリを含む全データ |
| [`dist/blocklist.csv`](dist/blocklist.csv) | 表計算・各種ツール向け |
| [`dist/stats.json`](dist/stats.json) | 件数の統計 |

```bash
# 数値IDの一覧
curl -sL https://raw.githubusercontent.com/mikumiku-jp/xgomi/main/dist/ids.txt

# scam カテゴリだけ抽出
curl -sL https://raw.githubusercontent.com/mikumiku-jp/xgomi/main/dist/blocklist.json \
  | jq -r '.accounts[] | select(.categories | index("scam")) | .username'
```

## 報告する

[**アカウントを報告する**](../../issues/new?template=1-report.yml) から Issue を送ってください。
書くのは3つだけです。タイトルは自動で付きます。

1. 対象アカウント（`@handle` かプロフィールURL）
2. カテゴリ
3. 証拠ツイートのURL（**1件から**。2件以上あるとレビューが早く済みます）

送信後、GitHub Actions が自動で:

1. `@handle` から **数値ID** を解決する
2. 証拠ツイートを取得し、**投稿者が本当にその人か照合**する
3. `accounts/<数値ID>.json` を作って **PR を出す**

証拠が1件でも通らなければ全体を差し戻し、理由を Issue にコメントします。
本文を直せば自動で再検証されます。

PR がマージされても却下されても、Issue は結果コメント付きで自動的に閉じます。

- 掲載に誤りがある → [掲載解除をリクエスト](../../issues/new?template=2-removal.yml)
- カテゴリの提案・不具合・質問 → [その他](../../issues/new?template=3-other.yml)
- 手で PR を送りたい → [CONTRIBUTING.md](CONTRIBUTING.md)
- リポジトリを運用する → [MAINTAINING.md](MAINTAINING.md)

## カテゴリ

定義は [POLICY.md](POLICY.md) にあります。

| | |
| --- | --- |
| **AI関連** | `ai-hype` 驚き屋 / `ai-slop` AI生成の粗製濫造 / `undisclosed-ai` AI生成の秘匿 / `fake-demo` 捏造デモ |
| **転載・なりすまし** | `plagiarism` 無断転載 / `content-farm` 無断転載まとめへの誘導 / `impersonation` なりすまし |
| **収益誘導** | `affiliate-spam` アフィリエイト誘導 / `info-product` 情報商材 / `undisclosed-promo` ステマ / `scam` 詐欺 |
| **インプレ稼ぎ・攪乱** | `engagement-farming` インプレ稼ぎ / `rage-bait` 対立煽り / `bot-automation` bot・自動投稿 / `adult-spam` アダルト誘導 |
| **その他** | `misinformation` 誤情報 |

## なぜ username ではなく数値ID なのか

`@handle` はいつでも変更できます。数値ID (`rest_id`) はアカウント削除まで変わりません。
username で管理すると改名した時点で追跡できなくなり、さらに
**手放された古いハンドルを取得した無関係の第三者** を巻き込む事故が起きます。

そのため:

- **主キーは数値ID** — ファイル名も `accounts/<数値ID>.json`
- `username` は登録時点のスナップショットにすぎない
- 改名を検知したら `username_history` へ退避

改名の検知には証拠ツイートを使っています。
X のツイート取得は投稿者の **現在の** ハンドルを返すため、
「数値ID → 現在の username」の逆引きとして機能します。これを毎日回しています。

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
  "evidence": [                    // 1件以上。投稿者IDをCIが照合
    { "url": "https://x.com/example/status/1234567890123456789" }
  ],
  "note": "何が問題なのかの客観的な説明",
  "status": "listed",              // listed / username-changed / suspended / deleted / delisted
  "added_at": "2026-01-01",
  "updated_at": "2026-01-01"
}
```

掲載解除したエントリは削除せず `status: delisted` にします。
消すと解除の経緯が追えず、同じ報告が繰り返されるためです（`dist/` からは除外）。

## 自動化

| ワークフロー | 契機 | 動作 |
| --- | --- | --- |
| `issue-to-pr` | `report` Issue | JSON 化して PR を作成。タイトルも付ける |
| `validate` | PR | 変更されたエントリを検証（証拠の投稿者照合を含む） |
| `pr-closed` | PR のクローズ | 元の Issue を結果付きで閉じる |
| `removal-triage` | `removal` Issue | 証拠の生死と投稿者を確かめ、判断材料をコメント |
| `delist-command` | メンテナの `/delist` | 掲載解除の PR を作成 |
| `build` | main への push | `dist/` を再生成 |
| `refresh` | 毎日 / 手動 | 改名・凍結・証拠の削除を検知して PR を作成 |
| `stale` | 毎週 | 動きのない報告 Issue を閉じる |

## 手元で動かす

```bash
node scripts/selftest.mjs              # 定義の整合性チェック
node scripts/validate.mjs              # 形式チェック（オフライン）
node scripts/validate.mjs --network    # 証拠の投稿者IDまで照合
node scripts/build.mjs                 # dist/ を生成
node scripts/refresh.mjs               # 改名・凍結を追跡
```

## ライセンス

データ（`accounts/`, `dist/`）は [CC0-1.0](LICENSE)。スクリプト（`scripts/`）は MIT。

## 免責

掲載は各投稿の内容についての評価であり、人物の否定ではありません。
誤りがあれば [掲載解除リクエスト](../../issues/new?template=2-removal.yml) から申請してください。
このデータを嫌がらせ・通報の呼びかけに使うことは [POLICY.md](POLICY.md) で禁止しています。
