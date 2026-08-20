# xgomi — X blocklist filter (userscript)

ブロックリスト（**username** と **user id**）を読み込んで、対象アカウントとその投稿を
X (twitter.com / x.com) の **TL・検索・通知・返信欄・おすすめ・トレンド・検索候補** から丸ごと消すユーザースクリプト。

相手をブロック/ミュートするわけではない。**消えるのは自分の画面だけ**で、送信するリクエストは
リスト取得と（許可した場合のみ）id→username の逆引きだけ。どちらも GET で、書き込み系APIは一切呼ばない。

## インストール

1. [Tampermonkey](https://www.tampermonkey.net/)（または [Violentmonkey](https://violentmonkey.github.io/)）を入れる
2. **[xgomi.user.js をインストール](https://raw.githubusercontent.com/mikumiku-jp/xgomi/main/userscript/xgomi.user.js)** を開く → 確認画面が出る
3. x.com を開く → 画面左下の小さい `xgomi` ボタン、または Tampermonkey メニューの「xgomi ダッシュボード」

このURLから入れれば、以後の更新は Tampermonkey が自動で取りに来ます。
ファイルを直接ドラッグしたり中身を貼った場合は、更新は届きません。

## ソースの形式

デフォルトソース: `https://raw.githubusercontent.com/mikumiku-jp/xgomi/main/dist/blocklist.csv`

3形式を自動判別する。

**CSV**（`id` と `username` 列があれば対応表として読む。`status` が `delisted` の行は無視）

```csv
id,username,categories,severity,status
1646160030352257025,someuser,info-product,medium,listed
```

**JSON**（配列、または `accounts` / `users` / `entries` / `list` を持つオブジェクト）

```json
{ "accounts": [{ "id": "1646...", "username": "someuser", "status": "listed" }] }
```

**テキスト**（1行1件、判定は自動）

```text
1646160030352257025             # 数字だけ  → user id
1646160030352257025 someuser    # 空白区切りも id として読む
1646160030352257025, @someuser  # id + @username → 対応表にも登録
1646160030352257025, spam       # @ なしの2列目は無視（下記）
@BadGuy                         # @付き    → username
someuser                        # 英数字   → username
id:1646160030352257025          # 明示指定
username:someuser               # 明示指定
https://x.com/someuser          # URLでもOK
# 行頭 # / // / ; はコメント
```

列名の行がないテキストでは、2列目を username とみなすのは **`@` が付いているときだけ**。
この位置には理由や分類を書くリストが多く、推測すると `1646...,spam` から
**無関係の @spam を消してしまう**ため。列名の行（`id,username,...`）がある CSV なら
列位置で判断するので `@` は不要。

ソースは複数追加でき、個別に ON/OFF・手動更新・削除ができる（ダッシュボード → ソース）。
一度取得した内容はローカルにキャッシュされるので、オフラインでも直前のリストで動く。

GitHub 以外のホストからソースを取る場合、Tampermonkey が初回に「このドメインへの接続を許可しますか」と聞く。
これは `@connect` に github.com 系しか宣言していないため。許可すればそのまま使える。

## 仕組み（2層）

| 層 | 内容 |
| --- | --- |
| API層 | `fetch` と `XMLHttpRequest` をフックし、GraphQL/REST の JSON レスポンスからブロック対象の entry を**描画される前に**削除。対象を含まない応答は原文をそのまま返す（再シリアライズなし） |
| DOM層 | MutationObserver で `cellInnerDiv` / `article` / `UserCell` / 検索候補などを監視し、該当要素を `remove()` |

## id → username の逆引き

id だけ指定されたアカウントは、username が分からないと DOM 層で判定できない。

- **対応表を配っているソース**（CSV/JSON の `username` 列、txt の `id, username` 行）は、その対応表をそのまま使う。
  この場合 x.com への問い合わせは**一切発生しない**し、`ID` タブも出ない
- **対応表を配っていないソースを追加した時**だけ「逆引きしますか？」と確認する。
  許可すると `GraphQL/UserByRestId`（読み取り専用）で username を引き、対応表に保存する。
  断れば逆引きはせず、そのidは API 層でのみ除去される（あとから ソース タブの「逆引き」ボタンで切り替え可能）
- APIレスポンスから username が判明した分は自動で対応表に加わる

## 投稿の「…」メニューから追加

各投稿の「…」メニューに **「@xxx をxgomiで消す」** が入る（Xのメニュー項目を複製しているので見た目・ホバーは完全にネイティブ）。
押すと確認モーダルが出て、OKした時だけリストに入る。登録済みのアカウントでは「xgomiから外す」に変わる。

## 設定（ダッシュボード → 設定）

- **有効** — マスタースイッチ。OFF の間は連動する設定がグレーアウトし、概要に「停止中」バナーが出る
- **API段階で除去** — 描画前に消す（既定 ON、最も確実）
- **メンションも対象** — 対象を `@` で言及しただけの第三者の投稿も消す（既定 OFF）
- **プロフィールを非表示** — 対象のプロフィールページを「このアカウントは非表示です」に置き換える（既定 ON）。
  「表示する」を押すとその場かぎりで解除（保存はしない）
- **idを自動で逆引き** — 逆引きを許可したソースの id だけ問い合わせる（既定 ON）
- **ボタンを表示** — 画面左下の `xgomi` ボタン
- **投稿のメニューに追加** — 「…」メニューへの項目追加（既定 ON）
- **削除方法** — `DOMから削除`（既定）/ `display:none で隠す`
- **自動更新** — N時間ごとにソースを再取得（既定 6h）
- **ログ保持件数** / **統計をリセット** / エクスポート・インポート（設定・リスト・対応表を JSON で）

## タブ

`概要`（件数・削除統計・手動更新・再スキャン）/ `リスト`（手動追加・削除・例外・報告リストから issue 作成）/
`ソース`（URL管理・対応表の有無・逆引きの許可）/ `ID`（id↔username 対応表、**逆引きが必要な時だけ表示**）/
`設定` / `ログ`（直近の削除履歴）

## メモ

- 削除は自分の画面上だけの処理。相手のブロック/ミュートは行わない（POSTリクエストを一切送らない）
- リポスト・引用元・返信ツリー内に対象が含まれる投稿も削除対象
- **例外リスト**に入れたアカウントは、ソースに載っていても消さない
- ダッシュボードは Shadow DOM 内で完結。配色は X のテーマ（ライト/ダーク/ダークブルー）とアクセント色を自動追従

## 不具合・要望

[xgomi の Issue](https://github.com/mikumiku-jp/xgomi/issues) へどうぞ。
ブロックリストへの掲載依頼・削除依頼は、リポジトリの [報告フォーム](https://github.com/mikumiku-jp/xgomi/issues/new/choose)から。

## ライセンス

MIT。詳細は[リポジトリの LICENSE](../LICENSE)。
