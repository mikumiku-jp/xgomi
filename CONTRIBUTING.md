# 貢献方法

先に [POLICY.md](POLICY.md) を読んでください。
形式がどれだけ正しくても、掲載基準に合わないものは却下されます。

## Issue から報告する

ほとんどの場合はこちらで足ります。
[アカウントを報告する](../../issues/new?template=1-report.yml) から送信してください。

数値IDの解決も、証拠ツイートの照合も、JSONの生成も自動で行われます。
Gitの操作は一度も出てきません。

対象アカウントは1行に1件で、最大10件までまとめられます。
証拠のURLは全員分を並べて貼るだけで、投稿者から自動で振り分けます。
カテゴリは全件共通になるので、別々に付けたいときは Issue を分けてください。

検証に失敗すると理由がIssueにコメントされます。
本文を編集すれば、そのまま再検証が走ります。

## 手動でPRを送る

証拠ツイートが削除済みで魚拓しかない場合など、自動変換が使えないときはこちらです。

```bash
git clone https://github.com/mikumiku-jp/xgomi
cd xgomi
```

### 数値IDを調べる

ファイル名になるのは `username` ではなく数値IDです。

```bash
node -e '
  const { userByScreenName } = await import("./scripts/lib/x.mjs");
  console.log(await userByScreenName(process.argv[1]));
' example
```

### エントリを作る

`accounts/<数値ID>.json` を作成します。

```json
{
  "$schema": "../schema/account.schema.json",
  "id": "1234567890",
  "username": "example",
  "categories": ["ai-hype"],
  "severity": "medium",
  "evidence": [
    {
      "url": "https://x.com/example/status/1234567890123456789",
      "note": "存在しない機能を「実装した」と主張",
      "archive_url": "https://web.archive.org/web/.../"
    }
  ],
  "added_at": "2026-02-11",
  "updated_at": "2026-02-11"
}
```

`$schema` を書いておくと、エディタで補完と検証が効きます。

### 検証する

```bash
node scripts/validate.mjs --network accounts/1234567890.json
```

`--network` を付けると、証拠ツイートの投稿者が本当に `id` と一致するかまで照合します。
ここを通らないPRはマージされません。
人違いを防ぐ最後の砦なので、例外は作りません。

### 送る

```bash
git checkout -b add/example
git add accounts/1234567890.json
git commit -m "追加: @example (id=1234567890)"
git push origin add/example
```

`dist/` はコミットしないでください。
main へのマージ後にCIが再生成します。

## 既存エントリを更新する

証拠の追加、カテゴリの修正、`archive_url` の補完は歓迎します。
`updated_at` を更新してください。

同じアカウントをIssueから再報告した場合も、証拠が既存エントリにマージされる形でPRが作られます。

## レビューで見られること

形式チェックはCIが済ませているので、レビューは中身だけを見ます。

- カテゴリが [POLICY.md](POLICY.md) の定義に実際に該当するか
- 単発の言い間違いや勘違いを咎めるものになっていないか
- 私怨や意見の不一致による報告になっていないか
- 個人情報や人格攻撃が含まれていないか

判断が割れる場合はPR上で議論します。
急いでマージはしません。

## 掲載解除

[掲載解除リクエスト](../../issues/new?template=2-removal.yml) を使ってください。
本人からの申請でも第三者からの指摘でも受け付けます。
身元を示す情報は書かないでください。

申請が届くと、証拠ツイートが今も生きているか、投稿者が本当にそのIDなのかを自動で確かめてコメントします。
解除するかどうかは人が判断します。

解除してもエントリは削除せず、`status` を `delisted` にして理由を残します。
同じ報告が繰り返されたときに、一度判断した記録がないと同じ議論をやり直すことになるからです。
配布物からは除外されます。

## 提案や不具合

カテゴリの追加提案、スクリプトの不具合、ポリシーへの意見は[その他](../../issues/new?template=3-other.yml) からどうぞ。

カテゴリを提案するときは、「これは含まない」の線引きまで書いてください。
定義が広すぎるカテゴリは正当な活動を巻き込み、リスト全体の信用を下げます。

## 開発

依存パッケージはありません。
Node.js 18 以降だけで動きます。

```text
scripts/
  lib/x.mjs             X の公開エンドポイントへのクライアント（APIキー不要）
  lib/validate-core.mjs 検証ロジック
  lib/issue-form.mjs    Issue Form 本文の分解
  validate.mjs          検証 CLI
  build.mjs             dist/ 生成
  issue-to-json.mjs     Issue Form から accounts/<id>.json へ
  refresh.mjs           改名や凍結、証拠削除の追跡
  removal-triage.mjs    掲載解除リクエストの下調べ
  delist.mjs            掲載解除の適用
  selftest.mjs          自己テスト
```

カテゴリの定義や制約は `schema/account.schema.json` と `scripts/lib/validate-core.mjs` の両方にあります。
片方だけ変えても動いてしまうので、ずれたら落ちるようにしてあります。

```bash
node scripts/selftest.mjs
```
