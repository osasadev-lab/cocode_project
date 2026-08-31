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
      // 退出後に同じ招待リンクを再訪したゲストを、localStorageの再訪識別ID
      // (guest identity)経由でparticipantId付き再接続させている場合にtrue
      // (不具合修正§6、2026-08-31新設)。このIDが既にサーバー側で失効していた
      // 場合のみ、guest-landingへフォールバックさせるためのスコープ限定に使う。
      viaGuestIdentity?: boolean;
    };

// sessionUrl は、セッション参加用の URL（?s=<id>&t=<token>）を組み立てる。
//
// cocode は静的 HTML として書き出される（next.config.js の output: "export"）ため、
// 動的な /s/[id] ルートは存在しない。代わりにこの単一ページが、URL の
// クエリ文字列から自分の役割を判断する（仕様書§3のルーティング注記, §5.1, §10-2）。
// クエリ文字列なしの素の URL はホスト用トップページ/待ち合わせ地点を選ぶ画面であり、
// ホスト・ゲストいずれもライブ共有中は必ず `?s=<id>&t=<token>` 形式の URL を見る。
// ホスト自身のトークンは、招待リンク（ゲストのトークンを含む）とは別の
// 個人用 URL を形成する。localStorage から再開したセッションは、
// 表示内容と URL が常に一致するよう replaceState でアドレスバーを書き換える。
function sessionUrl(sessionId: string, token: string): string {
  return `/?s=${encodeURIComponent(sessionId)}&t=${encodeURIComponent(token)}`;
}

// Page: cocode のトップレベルページ。URL とローカル保存されたセッションから
// 現在の Mode を判定し、対応する画面を表示する。
export default function Page() {
  // 2026-08-31改訂(AdSense審査対策の一環): 初期状態を「読み込み中」の
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

    // URL にセッション情報（s, t）があれば、ゲスト（または招待URLを踏んだ
    // ホスト本人）としてアクセスしている。同一セッションへの参加履歴
    // （participantId）が localStorage にあれば自動復帰、無ければ
    // ゲスト用トップページ(初回参加、§14.2)を経由させる。
    if (s && t) {
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
        onCreated={(sessionId, token, participantId, shareUrl, transportMode, expiresAt) => {
          window.history.replaceState(null, "", sessionUrl(sessionId, token));
          // 作成直後は中間画面を挟まずそのままライブ地図へ入る(RoomCreatedScreen
          // は廃止、フッターの「リンク共有」で招待URL・QRコードは十分に賄える、
          // 2026-08-31)。ここでlocalStorageに保存しておくことで、この直後に
          // リロードされてもresume-choice経由でライブ地図へ正しく復帰できる。
          saveSession({ sessionId, token, participantId, role: "host", expiresAt, shareUrl });
          setMode({ kind: "session", sessionId, token, participantId, shareUrl, initialTransportMode: transportMode });
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
          window.history.replaceState(null, "", sessionUrl(stored.sessionId, stored.token));
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
        onJoin={(displayName, avatarIcon, transportMode) => {
          // 移動手段は参加登録(WebSocket接続)より前、LandingGuest側の
          // 経路プレビューステップで確定済み(2026-08-31再改訂: 参加確定前に
          // 「参加済み」扱いになってしまう不具合があったため、WS接続自体を
          // 最終確認ボタンまで遅延させた)。
          setMode({
            kind: "session",
            sessionId: mode.sessionId,
            token: mode.token,
            newProfile: { displayName, avatarIcon },
            initialTransportMode: transportMode,
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
      announceRejoin={mode.viaGuestIdentity}
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
