# 貢献方法

まず [POLICY.md](POLICY.md) を読んでください。掲載基準に合わないものは形式が正しくても却下されます。

## 1. Issue から報告する（推奨）

[アカウントを報告する](../../issues/new?template=1-report.yml) から送信してください。
数値ID の解決も、証拠ツイートの照合も、JSON の生成も自動で行われます。
GitHub の操作に慣れていなくても報告できます。

検証に失敗すると理由が Issue にコメントされます。**Issue 本文を編集すれば自動で再検証されます。**

## 2. 手動で PR を送る

証拠ツイートが削除済みで魚拓しかない場合など、自動変換が使えないときはこちらです。

```bash
git clone https://github.com/mikumiku-jp/xgomi
cd xgomi
```

### 数値ID を調べる

`username` ではなく **数値ID がファイル名** になります。次のコマンドで解決できます。

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
**ここを通らないPRはマージされません。** 人違いを防ぐための最重要チェックです。

### 送る

```bash
git checkout -b add/example
git add accounts/1234567890.json
git commit -m "追加: @example (id=1234567890)"
git push origin add/example
```

`dist/` は **コミットしないでください**。main へのマージ後に CI が再生成します。

## 既存エントリを更新する

証拠の追加、カテゴリの修正、`archive_url` の補完などは歓迎します。
`updated_at` を更新してください。

同じアカウントを Issue から再報告すると、証拠が既存エントリにマージされる形で PR が作られます。

## レビューで見られること

形式チェックは CI が済ませているので、レビューは中身に集中します。

- カテゴリが [POLICY.md](POLICY.md) の定義に **実際に** 該当するか
- 単発の言い間違い・勘違いを咎めるものになっていないか
- 私怨・意見の不一致による報告になっていないか
- 個人情報・人格攻撃が含まれていないか

判断が割れる場合は PR 上で議論します。急いでマージはしません。

## 掲載解除

[掲載解除リクエスト](../../issues/new?template=2-removal.yml) を使ってください。
本人からの申請でも第三者からの指摘でも受け付けます。身元を示す情報は書かないでください。

申請が届くと、証拠ツイートが今も生きているか、投稿者が本当にそのIDなのかを
自動で確かめてコメントします。解除するかどうかは人が判断します。

解除してもエントリは削除せず、`status` を `delisted` にして理由を残します。
同じ報告が繰り返されたときに、一度判断した記録が必要だからです。配布物からは除外されます。

## その他の提案・不具合

カテゴリの追加提案、スクリプトの不具合、ポリシーへの意見などは
[その他](../../issues/new?template=3-other.yml) からどうぞ。

カテゴリを提案する場合は、**「これは含まない」の線引き** まで書いてください。
定義が広すぎるカテゴリは正当な活動を巻き込み、リスト全体の信用を下げます。

## 開発

依存パッケージはありません。Node.js 18 以降のみです。

```text
scripts/
  lib/x.mjs             X の公開エンドポイントへのクライアント（APIキー不要）
  lib/validate-core.mjs 検証ロジック（schema/account.schema.json と対応）
  lib/issue-form.mjs    Issue Form 本文の分解
  validate.mjs          検証 CLI
  build.mjs             dist/ 生成
  issue-to-json.mjs     Issue Form → accounts/<id>.json
  refresh.mjs           改名・凍結・証拠削除の追跡
  removal-triage.mjs    掲載解除リクエストの下調べ
  delist.mjs            掲載解除の適用
  selftest.mjs          自己テスト
```

`schema/account.schema.json` を変更したら `scripts/lib/validate-core.mjs` も追従させてください。
両者は独立しており自動では同期しませんが、ずれていると `scripts/selftest.mjs` が落ちます。

```bash
node scripts/selftest.mjs
```
