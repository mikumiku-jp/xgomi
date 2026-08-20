# xgomi

Xのゴミ垢ブロックリスト。
AI驚き屋、無断転載まとめアフィ、情報商材、インプレ稼ぎ、bot。
種類は問いません。

自分のタイムラインを自分で整えるためのデータセットです。
報告に必要なのはアカウントと証拠URLだけで、数値IDの解決からPRの作成までは自動で進みます。

> [!IMPORTANT]
> 掲載には検証できる証拠ツイートが必須です。
> 掲載基準と禁止事項は [POLICY.md](POLICY.md) にあります。

## 使う

`dist/` を直接読み込めます。

| ファイル | 用途 |
| --- | --- |
| [`dist/ids.txt`](dist/ids.txt) | 数値IDのみ。改名に強いので推奨 |
| [`dist/usernames.txt`](dist/usernames.txt) | 現在の @handle のみ |
| [`dist/blocklist.json`](dist/blocklist.json) | 証拠とカテゴリを含む全データ |
| [`dist/blocklist.csv`](dist/blocklist.csv) | 表計算や各種ツール向け |
| [`dist/stats.json`](dist/stats.json) | 件数の統計 |

```bash
# 数値IDの一覧
curl -sL https://raw.githubusercontent.com/mikumiku-jp/xgomi/main/dist/ids.txt

# scam カテゴリだけ抽出
curl -sL https://raw.githubusercontent.com/mikumiku-jp/xgomi/main/dist/blocklist.json \
  | jq -r '.accounts[] | select(.categories | index("scam")) | .username'
```

## 報告する

[アカウントを報告する](../../issues/new?template=1-report.yml) から Issue を送ります。
書くのは3つだけで、タイトルは自動で付きます。

1. 対象アカウント（`@handle` かプロフィールURL）
2. カテゴリ
3. 証拠ツイートのURL（1件から。2件以上あるとレビューが早く済みます）

送信すると、GitHub Actions が数値IDを解決し、証拠ツイートを取得して、その投稿者が本当に対象アカウントなのかを照合します。
ここを通ったものだけが `accounts/<数値ID>.json` になり、PRが立ちます。

証拠が1件でも照合できなければ、全体を差し戻して理由をコメントします。
Issue本文を直せば、そのまま再検証が走ります。

PRがマージされても却下されても、Issueは結果のコメント付きで自動的に閉じます。

- 掲載に誤りがある → [掲載解除をリクエスト](../../issues/new?template=2-removal.yml)
- カテゴリの提案、不具合、質問 → [その他](../../issues/new?template=3-other.yml)
- 手でPRを送りたい → [CONTRIBUTING.md](CONTRIBUTING.md)
- リポジトリを運用する → [MAINTAINING.md](MAINTAINING.md)

## カテゴリ

定義は [POLICY.md](POLICY.md) にあります。

| グループ | カテゴリ |
| --- | --- |
| AI関連 | `ai-hype` 驚き屋、`ai-slop` AI生成の粗製濫造、`undisclosed-ai` AI生成の秘匿、`fake-demo` 捏造デモ |
| 転載となりすまし | `plagiarism` 無断転載、`content-farm` まとめサイトへの誘導、`impersonation` なりすまし |
| 収益誘導 | `affiliate-spam` アフィリエイト誘導、`info-product` 情報商材、`undisclosed-promo` ステマ、`scam` 詐欺 |
| インプレ稼ぎと攪乱 | `engagement-farming` インプレ稼ぎ、`rage-bait` 対立煽り、`bot-automation` 自動投稿、`adult-spam` アダルト誘導 |
| その他 | `misinformation` 誤情報 |

## なぜ username ではなく数値IDなのか

`@handle` はいつでも変更できます。
数値ID（`rest_id`）はアカウントを消すまで変わりません。

username を主キーにすると、改名された時点で追跡が切れます。
それだけなら実害は取りこぼしで済みますが、もっと悪いことが起きます。
手放された古いハンドルを別の誰かが取得したとき、その無関係な第三者がブロックされます。

そのためファイル名も `accounts/<数値ID>.json` にしてあり、`username` は登録時点のスナップショットとしてしか扱いません。
改名を検知したら `username_history` へ退避します。

その改名の検知に、証拠ツイートを使っています。
Xのツイート取得は投稿者の現在のハンドルを返すため、数値IDから現在の username への逆引きとして機能するからです。
これを毎日回しています。

## データ構造

```jsonc
// accounts/1234567890.json
{
  "$schema": "../schema/account.schema.json",
  "id": "1234567890",              // ファイル名と一致。改名しても変わらない
  "username": "example",           // 最終確認時点のスナップショット
  "display_name": "Example",
  "categories": ["ai-hype"],
  "severity": "medium",            // low / medium / high
  "evidence": [                    // 投稿者IDをCIが照合する
    { "url": "https://x.com/example/status/1234567890123456789" }
  ],
  "note": "何が問題なのかの客観的な説明",
  "status": "listed",              // listed / username-changed / suspended / deleted / delisted
  "added_at": "2026-01-01",
  "updated_at": "2026-01-01"
}
```

掲載を解除したエントリは削除せず、`status` を `delisted` にします。
消してしまうと解除の経緯が追えず、同じ報告が何度も戻ってくるためです。
`dist/` からは除外されます。

## 自動化

| ワークフロー | 契機 | 動作 |
| --- | --- | --- |
| `issue-to-pr` | `report` Issue | JSON化してPRを作成。タイトルも付ける |
| `validate` | PR | 変更されたエントリを検証（証拠の投稿者照合を含む） |
| `pr-closed` | PRのクローズ | 元のIssueを結果付きで閉じる |
| `removal-triage` | `removal` Issue | 証拠の生死と投稿者を確かめ、判断材料をコメント |
| `delist-command` | メンテナの `/delist` | 掲載解除のPRを作成 |
| `build` | main への push | `dist/` を再生成 |
| `refresh` | 毎日と手動 | 改名や凍結、証拠の削除を検知してPRを作成 |
| `stale` | 毎週 | 動きのない報告Issueを閉じる |

## 手元で動かす

依存パッケージはありません。

```bash
node scripts/selftest.mjs              # 定義の整合性チェック
node scripts/validate.mjs              # 形式チェック（オフライン）
node scripts/validate.mjs --network    # 証拠の投稿者IDまで照合
node scripts/build.mjs                 # dist/ を生成
node scripts/refresh.mjs               # 改名と凍結を追跡
```

## ライセンス

データ（`accounts/`, `dist/`）は [CC0-1.0](LICENSE)、スクリプト（`scripts/`）は MIT。

## 免責

掲載は各投稿の内容についての評価であり、人物の否定ではありません。
誤りがあれば [掲載解除リクエスト](../../issues/new?template=2-removal.yml) から申請してください。

このデータを嫌がらせや通報の呼びかけに使うことは [POLICY.md](POLICY.md) で禁止しています。
