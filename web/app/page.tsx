"use client";

import { useLayoutEffect, useState } from "react";
import { CreateForm } from "@/components/CreateForm";
import { LandingGuest } from "@/components/LandingGuest";
import { LandingHost } from "@/components/LandingHost";
import { LiveSession } from "@/components/LiveSession";
import { ResumeSessionChoice } from "@/components/ResumeSessionChoice";
import { clearGuestIdentity, loadGuestIdentity, loadSession, saveSession, type StoredSession } from "@/lib/storage";
import type { TransportMode } from "@/lib/types";

// Mode: この単一ページが現在どの画面を表示すべきかを表す状態。
// - landing: ホスト用トップページ(共有リンクなし・復元セッションなし、§14.0)。
//   実データ判定が済むまでの既定値でもある(下記Page関数のコメント参照)。
// - create: 待ち合わせ地点の未選択（新規セッション作成前）
// - guest-landing: ゲスト用トップページ(初回参加、§14.2)
// - resume-choice: 共有中/参加中の状態で素の"/"へアクセスした場合の選択画面
//   (2026-08-31新設)。「共有中の画面を表示する」「停止して新しい共有を始める」
//   「共有を停止する」の3択を提示する(ホスト・ゲスト共通)。
// - session: セッション参加中（ライブ共有画面）。参加者IDが既知(再接続)の場合は
//   participantIdを、未参加(新規参加)の場合はnewProfileを設定する。
//   共有ルーム作成直後は中間画面を挟まず、そのままこのモードへ直行する
//   (フッターの「リンク共有」で既に十分なため、RoomCreatedScreenは廃止した、2026-08-31)。
type Mode =
  | { kind: "landing" }
  | { kind: "create" }
  | { kind: "guest-landing"; sessionId: string; token: string }
  | { kind: "resume-choice"; stored: StoredSession }
  | {
      kind: "session";
      sessionId: string;
      token: string;
      participantId?: string;
      newProfile?: { displayName: string; avatarIcon: string };
      shareUrl?: string;
      initialTransportMode?: TransportMode;
      /** 参加直後の位置情報オフモード(2026-09-02新設)。省略時はtrue(共有する)
       * として扱う(LiveSession側の既定値)。 */
      initialLocationSharing?: boolean;
      // 退出後に同じ招待リンクを再訪したゲストを、localStorageの再訪識別ID
      // (guest identity)経由でparticipantId付き再接続させている場合にtrue
      // (不具合修正§6、2026-08-31新設)。このIDが既にサーバー側で失効していた
      // 場合のみ、guest-landingへフォールバックさせるためのスコープ限定に使う。
      viaGuestIdentity?: boolean;
    };

// sessionUrl は、ゲスト参加用の URL（?s=<id>&t=<token>）を組み立てる。
//
// cocode は静的 HTML として書き出される（next.config.js の output: "export"）ため、
// 動的な /s/[id] ルートは存在しない。代わりにこの単一ページが、URL の
// クエリ文字列から自分の役割を判断する（仕様書§3のルーティング注記, §5.1, §10-2）。
// クエリ文字列なしの素の URL はホスト用トップページ/待ち合わせ地点を選ぶ画面。
function sessionUrl(sessionId: string, token: string): string {
  return `/?s=${encodeURIComponent(sessionId)}&t=${encodeURIComponent(token)}`;
}

// hostSessionUrl は、ホスト自身のライブ画面用の URL を組み立てる（2026-09-02新設）。
//
// 以前はホストの画面でも sessionUrl(sessionId, tokenHost) をアドレスバーへ
// replaceState していたが、これは招待リンク（?s=..&t=<tokenGuest>）と全く
// 同じ見た目でありながら tokenHost（セッション終了・目的地変更まで可能な
// ホスト権限そのもの）を含んでいた。ホストが誤ってアドレスバーの URL を
// コピーして送ってしまうと、招待リンクのつもりが実質的な「共同ホスト権限の
// 譲渡」になってしまう不具合があったため、ホストの画面では t を一切
// 出さないことにした。s のみで実害はない（下記 useLayoutEffect が示す通り、
// リロード時の復元は localStorage の token を使い、URL の t は使わないため）。
function hostSessionUrl(sessionId: string): string {
  return `/?s=${encodeURIComponent(sessionId)}`;
}

// Page: cocode のトップレベルページ。URL とローカル保存されたセッションから
// 現在の Mode を判定し、対応する画面を表示する。
export default function Page() {
  // 2026-08-31改訂: 初期状態を「読み込み中」の
  // プレースホルダーではなく、実際のトップページ内容にした。この値は
  // window/localStorageを読まない静的な既定値のため、サーバー側の
  // 静的書き出し(output: "export")時のHTMLとクライアントの初回レンダー
  // が一致し、hydrationエラーを起こさない。多くの実訪問(クエリ無し・
  // 復元セッション無し)ではこれがそのまま正しい表示になるため、
  // クローラーや初回訪問者に対して即座に実コンテンツが見える。
  // 復元セッション・招待リンクなど判定が必要なケースのみ、下記の
  // useLayoutEffect(ブラウザの描画前に同期的に実行される)で
  // 即座に正しいモードへ補正する。
  const [mode, setMode] = useState<Mode>({ kind: "landing" });

  useLayoutEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const s = params.get("s");
    const t = params.get("t");
    const stored = loadSession();

    // URL に s があれば、ゲスト（または招待/自分のURLを踏んだホスト本人）
    // としてアクセスしている。同一セッションへの参加履歴（participantId）が
    // localStorage にあれば、URL に t があるか（≒招待リンクか、tを含まない
    // ホスト自身のURL(hostSessionUrl)か）を問わず自動復帰する — 復帰には
    // 常に localStorage 側の token（stored.token）を使い、URL の t は
    // 参照しないため、これで復元結果が変わることはない。
    if (s) {
      if (stored && stored.sessionId === s && stored.participantId) {
        setMode({
          kind: "session",
          sessionId: s,
          token: stored.token,
          participantId: stored.participantId,
          shareUrl: stored.shareUrl,
        });
        return;
      }
      if (t) {
        // アクティブセッション（上記stored）は「退出する」操作でクリアされるが、
        // ゲストの再訪識別ID（guest identity）は別枠で残り続ける(不具合修正§6、
        // 2026-08-31新設)。これにより、一度退出したゲストが同じ招待リンクを
        // 再度開いても、サーバー側に新しい参加者レコードを作らせず(=参加人数の
        // 増殖・地図上の同一人物の重複マーカーを防ぎ)、既存の自分として再接続できる。
        const guestParticipantId = loadGuestIdentity(s);
        if (guestParticipantId) {
          setMode({ kind: "session", sessionId: s, token: t, participantId: guestParticipantId, viaGuestIdentity: true });
          return;
        }
        setMode({ kind: "guest-landing", sessionId: s, token: t });
        return;
      }
      // s のみ・tなし・localStorageにも一致するセッション無し: hostSessionUrlを
      // 誰かがブックマーク等から開いたが、この端末には参加情報が無いケース。
      // tが無い以上ゲストとして参加させることもできないため、下の通常判定へ
      // フォールスルーする（＝ホスト用トップページ等、素の"/"と同じ扱い）。
    }

    // URL には無いが localStorage に保存済み（かつ未失効）のセッションがあれば、
    // 黙って自動復帰するのではなく選択画面を挟む（ホスト・ゲスト共通、2026-08-31新設）。
    if (stored && stored.participantId) {
      setMode({ kind: "resume-choice", stored });
      return;
    }

    // どちらも無ければホスト用トップページから始める（§14.0）。
    setMode({ kind: "landing" });
  }, []);

  if (mode.kind === "landing") {
    return <LandingHost onStart={() => setMode({ kind: "create" })} />;
  }

  if (mode.kind === "create") {
    return (
      <CreateForm
        onCreated={(sessionId, token, participantId, shareUrl, transportMode, expiresAt, locationSharing) => {
          window.history.replaceState(null, "", hostSessionUrl(sessionId));
          // 作成直後は中間画面を挟まずそのままライブ地図へ入る(RoomCreatedScreen
          // は廃止、フッターの「リンク共有」で招待URL・QRコードは十分に賄える、
          // 2026-08-31)。ここでlocalStorageに保存しておくことで、この直後に
          // リロードされてもresume-choice経由でライブ地図へ正しく復帰できる。
          saveSession({ sessionId, token, participantId, role: "host", expiresAt, shareUrl });
          setMode({
            kind: "session",
            sessionId,
            token,
            participantId,
            shareUrl,
            initialTransportMode: transportMode,
            initialLocationSharing: locationSharing,
          });
        }}
        onCancel={() => setMode({ kind: "landing" })}
      />
    );
  }

  if (mode.kind === "resume-choice") {
    const stored = mode.stored;
    return (
      <ResumeSessionChoice
        stored={stored}
        onResume={() => {
          // ホストはtokenHostをアドレスバーに出さない(hostSessionUrl参照)。
          // ゲストは招待URLと同じ形の?s=..&t=<tokenGuest>のままでよい
          // (もともとその招待URL自体が既に共有済みで、新たな露出面ではないため)。
          window.history.replaceState(
            null,
            "",
            stored.role === "host" ? hostSessionUrl(stored.sessionId) : sessionUrl(stored.sessionId, stored.token)
          );
          setMode({
            kind: "session",
            sessionId: stored.sessionId,
            token: stored.token,
            participantId: stored.participantId,
            shareUrl: stored.shareUrl,
          });
        }}
        onStopped={(next) => {
          window.history.replaceState(null, "", "/");
          setMode({ kind: next });
        }}
      />
    );
  }

  if (mode.kind === "guest-landing") {
    return (
      <LandingGuest
        sessionId={mode.sessionId}
        token={mode.token}
        onJoin={(displayName, avatarIcon, transportMode, locationSharing) => {
          // 移動手段・位置情報共有の可否は参加登録(WebSocket接続)より前、
          // LandingGuest側の経路プレビューステップで確定済み(2026-08-31再改訂:
          // 参加確定前に「参加済み」扱いになってしまう不具合があったため、WS
          // 接続自体を最終確認ボタンまで遅延させた)。
          setMode({
            kind: "session",
            sessionId: mode.sessionId,
            token: mode.token,
            newProfile: { displayName, avatarIcon },
            initialTransportMode: transportMode,
            initialLocationSharing: locationSharing,
          });
        }}
      />
    );
  }

  return (
    <LiveSession
      sessionId={mode.sessionId}
      token={mode.token}
      participantId={mode.participantId}
      newProfile={mode.newProfile}
      shareUrl={mode.shareUrl}
      initialTransportMode={mode.initialTransportMode}
      initialLocationSharing={mode.initialLocationSharing}
      announceRejoin={mode.viaGuestIdentity}
      onTokensRotated={(newToken, newShareUrl) => {
        // トークン再発行(2026-09-02新設)。ホスト専用機能のため、アドレスバーは
        // 常にhostSessionUrl形式へ書き戻す(このコールバックはisHost時のみ
        // LiveSession側から呼ばれる)。
        window.history.replaceState(null, "", hostSessionUrl(mode.sessionId));
        setMode((m) => (m.kind === "session" ? { ...m, token: newToken, shareUrl: newShareUrl } : m));
      }}
      onLeft={() => {
        window.history.replaceState(null, "", "/");
        setMode({ kind: "landing" });
      }}
      onJoinFailed={
        mode.viaGuestIdentity
          ? () => {
              // 保存していたゲストの再訪識別IDが、サーバー側で既に失効していた
              // (10分の復帰猶予切れ等)ケース。IDを破棄し、通常の新規参加フロー
              // (ゲスト用トップページ)へフォールバックする(不具合修正§6)。
              clearGuestIdentity(mode.sessionId);
              setMode({ kind: "guest-landing", sessionId: mode.sessionId, token: mode.token });
            }
          : undefined
      }
    />
  );
}
