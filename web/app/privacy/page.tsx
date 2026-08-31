import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "プライバシーポリシー | cocode",
  description: "cocodeが取得する情報、利用目的、保存期間、第三者サービスについて説明します。",
};

export default function PrivacyPage() {
  return (
    <main className="cocode-doc">
      <h1 className="cocode-doc-title">プライバシーポリシー</h1>
      <p className="cocode-doc-lead">
        cocode(以下「本サービス」)における、利用者情報の取得・利用・保存について説明します。
      </p>

      <div className="cocode-doc-body">
        <section>
          <h2>1. 取得する情報</h2>
          <p>本サービスは、アカウント登録を必要としないため、氏名・メールアドレス・電話番号等の登録情報は取得しません。位置情報共有の機能を提供するにあたり、以下の情報を取得します。</p>
          <ul>
            <li>位置情報(緯度・経度、精度) — 共有を開始してから終了するまでの間、端末から送信される現在地</li>
            <li>表示名・選択したアイコン — 参加者を区別するために入力いただく任意の文字列・識別子</li>
            <li>目的地の座標・住所文字列 — ホストが設定した待ち合わせ場所</li>
            <li>移動手段(徒歩・車・電車)の選択状況</li>
            <li>フィードバック送信時の本文、および任意で入力いただいた返信用メールアドレス</li>
          </ul>
        </section>

        <section>
          <h2>2. 利用目的</h2>
          <p>取得した情報は、以下の目的にのみ利用します。</p>
          <ul>
            <li>参加者間でのリアルタイムな位置情報共有機能の提供</li>
            <li>目的地までの目安所要時間・経路の算出</li>
            <li>サービス改善のためのフィードバックへの対応</li>
          </ul>
          <p>取得した情報を、本サービスの提供に必要な範囲を超えて第三者へ販売・提供することはありません。</p>
        </section>

        <section>
          <h2>3. 保存期間</h2>
          <p>
            位置情報を含むセッションのデータは、セッション作成から1時間の固定期限、またはホストによる手動終了のいずれか早いタイミングで削除されます。フィードバックとして送信いただいた内容は、サービス改善の参考のため一定期間保存する場合があります。
          </p>
        </section>

        <section>
          <h2>4. アクセス制御</h2>
          <p>
            各セッションへのアクセスは、ランダムに生成されたセッショントークンを知っている端末からのみ可能です。共有リンクを知っている人は誰でも参加者全員の現在地を見ることができるため、信頼できる相手にのみ共有リンクを送るようご注意ください。
          </p>
        </section>

        <section>
          <h2>5. ローカルストレージの利用</h2>
          <p>
            再訪時に同じ共有へ自動的に復帰できるよう、お使いのブラウザのlocalStorage(端末内のみに保存される領域)にセッション識別情報を保存します。この情報は本サービスのサーバーへは送信されず、外部と共有されることもありません。
          </p>
        </section>

        <section>
          <h2>6. 第三者サービスの利用</h2>
          <p>本サービスは、機能提供のために以下の第三者サービスを利用しています。各サービスの詳細は、それぞれのプライバシーポリシーをご確認ください。</p>
          <ul>
            <li><strong>MapTiler</strong> — 地図タイルの表示、住所検索(ジオコーディング)</li>
            <li><strong>OSRM</strong> — 徒歩・車の経路探索(無料公開デモサーバー)</li>
            <li><strong>NAVITIME</strong> — 電車の経路・所要時間の算出(日本国内のみ)</li>
            <li><strong>Google AdSense</strong> — 広告の配信。Cookie等を利用して広告のパーソナライズを行う場合があります。詳細は<a href="https://policies.google.com/technologies/partner-sites" target="_blank" rel="noreferrer">Googleのポリシーと規約</a>をご確認ください。</li>
            <li><strong>Buy Me a Coffee</strong> — 任意の寄付受付(外部サイトへのリンク)</li>
          </ul>
        </section>

        <section>
          <h2>7. お問い合わせ</h2>
          <p>本ポリシーに関するお問い合わせは、サービス内のフィードバックフォームよりご連絡ください。</p>
        </section>

        <section>
          <h2>8. 改定</h2>
          <p>本ポリシーの内容は、サービスの変更に伴い予告なく改定される場合があります。改定後の内容は本ページに掲載した時点で効力を持つものとします。</p>
        </section>
      </div>

      <p className="cocode-doc-back">
        <a href="/">トップページに戻る</a>
      </p>
    </main>
  );
}
