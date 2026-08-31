"use client";

import { useEffect, useRef, useState } from "react";
import { MapView } from "./MapView";
import { MemberSidebar } from "./MemberSidebar";
import { ChatSidebar } from "./ChatSidebar";
import { ShareLinkModal } from "./ShareLinkModal";
import { TransportModal } from "./TransportModal";
import { ProfileEditModal } from "./ProfileEditModal";
import { SessionEndedScreen } from "./SessionEndedScreen";
import { GuestLeftScreen } from "./GuestLeftScreen";
import { NotFoundScreen } from "./NotFoundScreen";
import { useCocodeSocket, type SocketAuth } from "@/lib/useCocodeSocket";
import { useLiveLocation, haversineMeters, type GeoPoint } from "@/lib/geolocation";
import { ARRIVAL_RADIUS_M } from "@/lib/config";
import { computeTransitEta, endSession } from "@/lib/api";
import { avatarIconSrc } from "@/lib/avatars";
import { useDestinationPicker } from "@/lib/useDestinationPicker";
import type { TrainRouteInfo } from "@/lib/useTransportEtaOptions";
import { fetchRouteDurationSeconds } from "@/lib/routing";
import { clearGuestIdentity, clearSession, saveGuestIdentity, saveSession } from "@/lib/storage";
import type { LiveParticipant, LocationState, RouteStep as LiveSessionRouteStep, TransportMode } from "@/lib/types";
import { DestinationPickerPanel } from "./DestinationPickerPanel";

interface LiveSessionProps {
  sessionId: string;
  token: string;
  /** 再接続(参加済み)の場合に設定される。 */
  participantId?: string;
  /** 新規参加(初回のWS接続でparticipantIdがまだ発行されていない)の場合に設定される。 */
  newProfile?: { displayName: string; avatarIcon: string };
  /** ホストがこの端末でセッションを作成した直後のみ設定される。
   * ゲストが参加するまでの間、ホストが招待リンクを再度コピーできるよう表示する。 */
  shareUrl?: string;
  /** 表示名・アイコンと合わせて入力画面で選んだ移動手段(2026-08-31新設)。
   * WebSocket接続確立後、一度だけtransport_updateとして送信する
   * (既定の"walk"の場合は送信不要のためスキップする)。 */
  initialTransportMode?: TransportMode;
  /** 「トップページに戻る」操作用(ゲストの退出後の遷移先)。 */
  onLeft?: () => void;
  /** ゲストの再訪識別ID(localStorage)経由でparticipantId付き再接続を試みた
   * ものの、サーバー側で既に失効していて参加自体が失敗した場合に呼ばれる
   * (不具合修正§6、2026-08-31新設)。呼び出し元(page.tsx)は保存済みIDを破棄し、
   * 通常の新規参加フローへフォールバックする。 */
  onJoinFailed?: () => void;
  /** 「退出する」した後、招待リンクから再び参加したゲストの再接続である場合
   * にtrue(2026-09-01新設、page.tsxのviaGuestIdentity参照)。サーバーへ
   * announceRejoinとして伝わり、他参加者のチャットに「参加しました」が
   * 残る(通常の自動再接続では出さない)。 */
  announceRejoin?: boolean;
}

// toLocationState は GeoPoint（ブラウザの Geolocation API 由来）を
// サーバーとやり取りする LocationState 形式へ変換する。
function toLocationState(p: GeoPoint | null): LocationState | null {
  if (!p) return null;
  return { lat: p.lat, lng: p.lng, accuracy: p.accuracy, updatedAt: new Date().toISOString() };
}

// formatCountdown は残り時間(ms)を「59:52」形式に整形する。
function formatCountdown(ms: number): string {
  const clamped = Math.max(0, ms);
  const minutes = Math.floor(clamped / 60000);
  const seconds = Math.floor((clamped % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// LiveSession: セッション参加中（地図・参加者の状態・終了操作）のメイン画面。
//
// 2026-08-31改訂: ユーザー提示の参考モックアップに合わせ、ヘッダー
// (左:ブランド名/中央:残り時間/右:参加人数)・フッター(リンク共有/メンバー/
// 現在地に戻る/全員を収める/[ホストのみ]目的地変更/共有停止)のミニマルな
// 構成にし、地図を最大限広く表示するようにした。共有終了(ホスト)/退出
// (ゲスト)はフッター内の専用ボタンから直接呼び出す。目的地変更はホスト
// 限定(仕様書§9、backend側でもゲストによる変更は拒否される)。目的地変更時は
// 全参加者にトースト通知し、地図タップに加え住所検索でも変更できる。
// 移動手段の切替はメンバー一覧の自分の行から行う(TransportModal、OSRM/
// NAVITIME経由でETAを計算しtransport_updateとして配信)。
//
// v2.0は1対多(ホスト+複数ゲスト)モデル（仕様書§5.1）であり、地図上にも
// ライブ位置が取得できている参加者全員分のマーカー・徒歩/車の経路を描画する
// （N人対応、Phase 6§1）。電車モードの経路描画・経路トリミング・逸脱時の
// 自動再算出は別タスク(§9.2, §7.1.1)として引き続きPhase 6内の別項目で扱う。
export function LiveSession({
  sessionId,
  token,
  participantId,
  newProfile,
  shareUrl,
  initialTransportMode,
  onLeft,
  onJoinFailed,
  announceRejoin,
}: LiveSessionProps) {
  const auth: SocketAuth | null = participantId
    ? { token, participantId, announceRejoin }
    : newProfile
      ? { token, displayName: newProfile.displayName, avatarIcon: newProfile.avatarIcon }
      : null;
  const socket = useCocodeSocket(sessionId, auth);
  const { point: myPoint, error: myLocationError } = useLiveLocation(true);
  const isHost = socket.role === "host";
  const [ending, setEnding] = useState(false);
  const [localEnded, setLocalEnded] = useState(false);
  const [localLeft, setLocalLeft] = useState(false);
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);
  const [recenterTick, setRecenterTick] = useState(0);
  const [fitAllTick, setFitAllTick] = useState(0);
  const [focusTargetTick, setFocusTargetTick] = useState(0);
  // myTrainRoute: 自分が電車モードの間の経路線(2026-08-31実装)。自分自身は
  // 自分が送信したlocation_updateのブロードキャストを受け取らない(hub.goの
  // otherConnsは送信者を含まない)ため、他参加者と違いsocket.participants
  // 経由では手に入らず、ここでローカルに保持する(autoEtaKeyRefのエフェクト参照)。
  const [myTrainRoute, setMyTrainRoute] = useState<string | undefined>(undefined);
  const [membersOpen, setMembersOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [transportOpen, setTransportOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [changingTarget, setChangingTarget] = useState(false);
  const targetPicker = useDestinationPicker();
  const [toast, setToast] = useState<string | null>(null);
  const prevDestUpdatedAtRef = useRef<string | undefined>(undefined);
  const initialTransportSentRef = useRef(false);
  const autoEtaKeyRef = useRef<string | null>(null);

  // 入力画面で選んだ移動手段を、WS接続確立後に一度だけtransport_updateとして
  // 送信する(2026-08-31新設)。既定値"walk"はサーバー側の初期値と同じため送信を
  // 省略する。この時点ではまだ自分の現在地が取得できていないことが多いため、
  // ETAは計算しない(後からメンバー一覧の「変更」で計算・送信できる)。
  useEffect(() => {
    if (initialTransportSentRef.current) return;
    if (socket.status !== "open") return;
    if (!initialTransportMode || initialTransportMode === "walk") return;
    initialTransportSentRef.current = true;
    socket.sendTransportUpdate(initialTransportMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket.status, initialTransportMode]);

  // カウントダウン表示用に1秒ごとに再計算する。
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // 自分の位置が変化した時、および WebSocket が（再）接続した時の両方で
  // 現在の位置を送り直す。これにより、認証ハンドシェイク完了前に取得した
  // 位置情報が失われないようにする。
  useEffect(() => {
    if (!myPoint || socket.status !== "open") return;
    socket.sendLocationUpdate("live", myPoint);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myPoint, socket.status]);

  // sync受信でrole/participantId/expiresAtが判明するたび、localStorageを
  // 最新の状態に保つ（新規参加時は最初のsyncで初めてparticipantIdが判明するため、
  // ここで保存することで次回以降の自動復帰が可能になる。仕様書§14.3ステップ5）。
  useEffect(() => {
    if (!socket.selfParticipantId || !socket.role || !socket.expiresAt) return;
    saveSession({
      sessionId,
      token,
      participantId: socket.selfParticipantId,
      role: socket.role,
      expiresAt: socket.expiresAt,
      shareUrl,
    });
    // ゲストの再訪識別IDも合わせて保存する(不具合修正§6、2026-08-31新設)。
    // 「退出する」はStoredSession(上記saveSession)だけをクリアするため、
    // このIDは退出後も残り、次回同じ招待リンクを開いた際にサーバー側で
    // 新しい参加者レコードを作らせず既存の自分として再接続できる。
    if (socket.role === "guest") {
      saveGuestIdentity(sessionId, socket.selfParticipantId, socket.expiresAt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket.selfParticipantId, socket.role, socket.expiresAt]);

  // 参加(再接続)自体がサーバー側で失敗した場合(セッションが既に終了・
  // 失効済みなど)、呼び出し元へ通知する(不具合修正§6、2026-08-31新設)。
  //
  // 2026-08-31再改訂: 「ホストが共有を終了した後にゲストが(localStorageの
  // 保存済みセッションを使って)そのURLへアクセスすると、位置共有画面が
  // 表示されてしまう」不具合を修正。page.tsxの「stored(現在アクティブな
  // セッション)」経由での再接続時はonJoinFailedが配線されておらず
  // (viaGuestIdentity経由の再接続のみ配線されていた)、joinFailed時に
  // 何も起きず、sync未着のまま空の地図画面がそのまま表示され続けていた。
  // ここで参加失敗時は必ずlocalStorageの古いセッション情報を破棄しておく
  // (下のレンダー側のjoinFailed早期returnと合わせて、役割を問わず404を出す)。
  useEffect(() => {
    if (!socket.joinFailed) return;
    clearSession();
    clearGuestIdentity(sessionId);
    onJoinFailed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket.joinFailed]);

  // 目的地(destination)の更新時刻が変わるたびにトースト通知する
  // (2026-08-31新設、仕様書§9.1)。初回sync時は通知しない。ホスト自身の
  // 変更操作もuseCocodeSocket側の楽観的更新により同じ経路で検知できる。
  useEffect(() => {
    const updatedAt = socket.destination?.updatedAt;
    if (!updatedAt) return;
    const prev = prevDestUpdatedAtRef.current;
    prevDestUpdatedAtRef.current = updatedAt;
    if (prev === undefined || prev === updatedAt) return;
    setToast(isHost ? "目的地を変更しました" : "ホストが目的地を変更しました");
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket.destination?.updatedAt]);

  // サーバーからの拒否(profile_updateのクールダウン超過・expressionの
  // クールダウン超過・不正な値など)をトーストで表示する(2026-08-31新設)。
  // これまでsocket.errorMessageはどこにも表示されず、拒否が静かに無視されていた。
  useEffect(() => {
    if (!socket.errorMessage) return;
    setToast(socket.errorMessage);
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [socket.errorMessage]);

  // 参加者が切断した際の通知(仕様書§0、2026-08-31実装)。マーカー・経路・ETA
  // 表示自体はuseCocodeSocket側で既に正しく削除されているが、通知UI自体は
  // 未実装だった。復帰猶予タイマー(§5.6.1)による10分後の恒久退出との
  // 見分けはUI側では不要(参加者一覧・地図からの削除タイミングは即時切断時の
  // 一度のみで共通のため)。
  useEffect(() => {
    if (!socket.lastLeft) return;
    setToast(`${socket.lastLeft.displayName}さんとの接続が切れました`);
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [socket.lastLeft]);

  // スタンプ・アイコンリアクションの受信通知(仕様書§12.1-④⑤、2026-08-31実装)。
  // 自分自身が送った場合はサーバーから返ってこない(peer_expressionは他参加者
  // 宛のみ)ため、この効果は他の参加者からの受信時のみ発火する。
  useEffect(() => {
    if (!socket.lastExpression) return;
    const e = socket.lastExpression;
    setToast(e.kind === "reaction" ? `${e.displayName}さんが👋` : `${e.displayName}さん: ${e.text}`);
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [socket.lastExpression]);

  // 自分の位置はサーバーの反響を待たず即座に表示するため、myPoint由来の値を採用する。
  const myLive = toLocationState(myPoint);
  const self = socket.selfParticipantId ? socket.participants.get(socket.selfParticipantId) : undefined;
  const others = [...socket.participants.values()].filter((p) => p.id !== socket.selfParticipantId);
  // 目的地変更中(changingTarget=true)に地点を選んでいる間は、その地点を
  // プレビューとして目的地ピンに反映する(確定/キャンセルするまでは実際の
  // destinationはまだ変更されていない)。changingTargetがfalseの間は
  // targetPicker.pointが残っていてもプレビューには使わない(2026-08-31修正:
  // 「目的地変更」ボタンを押していない状態でも地図タップだけで目的地が
  // 変わって見えてしまう不具合があったため、両方の条件を必須にした)。
  const target =
    changingTarget && targetPicker.point
      ? { lat: targetPicker.point.lat, lng: targetPicker.point.lng, updatedAt: new Date().toISOString() }
      : socket.destination;
  const selfLabel = self?.displayName ?? "あなた";
  const selfAvatarSrc = self ? avatarIconSrc(self.avatarIcon) : undefined;
  const participantCount = socket.participants.size;

  // isNearDestination: 地図マーカーの到着バッジ用(2026-08-31新設)。
  // socket.arrivedIds自体は一度到着したら恒久的に立ったままの「その人が
  // セッション中に到着したという事実」を表す(参加者一覧のバッジ・
  // アクティビティログはこのまま履歴として残すのが正しい)。一方、地図上の
  // マーカーは現在地を表すため、到着後に目的地から離れてもバッジが付いた
  // ままだと「その場所にいないのに到着マークが付いている」ように見えて
  // 混乱を招く。地図マーカーのバッジだけは「現在も目的地の半径内にいるか」
  // で別途判定する。
  function isNearDestination(lat: number, lng: number): boolean {
    if (!socket.destination) return false;
    return haversineMeters({ lat, lng }, socket.destination) <= ARRIVAL_RADIUS_M;
  }

  // 地図に描画する全参加者(自分含む)のライブ位置一覧(N人対応、仕様書§8)。
  // ライブ位置がまだ届いていない参加者(Geolocation許可待ち・初回GPS取得前)は
  // 描画対象から除く。自分の位置はサーバーからの反響を待たずmyLiveを使う。
  const liveParticipants: LiveParticipant[] = [];
  if (myLive && socket.selfParticipantId) {
    liveParticipants.push({
      id: socket.selfParticipantId,
      lat: myLive.lat,
      lng: myLive.lng,
      label: selfLabel,
      avatarSrc: selfAvatarSrc,
      isSelf: true,
      transportMode: self?.transportMode ?? "walk",
      arrived: socket.arrivedIds.has(socket.selfParticipantId) && isNearDestination(myLive.lat, myLive.lng),
      routePolyline: self?.transportMode === "train" ? myTrainRoute : undefined,
    });
  }
  for (const p of others) {
    if (!p.live) continue;
    liveParticipants.push({
      id: p.id,
      lat: p.live.lat,
      lng: p.live.lng,
      label: p.displayName,
      avatarSrc: avatarIconSrc(p.avatarIcon),
      routePolyline: p.transportMode === "train" ? p.routePolyline : undefined,
      isSelf: false,
      transportMode: p.transportMode,
      arrived: socket.arrivedIds.has(p.id) && isNearDestination(p.live.lat, p.live.lng),
    });
  }

  // 自分の現在地・目的地・移動手段が揃ったら、目安所要時間を自動計算して
  // 送信する(2026-08-31追加)。これまでは参加者一覧の「変更」からTransportModalを
  // 開いて手動選択した場合しかETAが計算されず、既定の徒歩のまま何もしないと
  // 参加者一覧に所要時間が一切表示されない不具合があった。(mode, 目的地座標)の
  // 組み合わせごとに一度だけ計算し(仕様書§7.1の「呼び出し頻度の抑制」に配慮)、
  // 目的地変更時・移動手段変更時にのみ再計算する。
  useEffect(() => {
    if (!myLive || !target || !self) return;
    const mode = self.transportMode;
    const key = `${mode}|${target.lat.toFixed(5)},${target.lng.toFixed(5)}`;
    if (autoEtaKeyRef.current === key) return;
    autoEtaKeyRef.current = key;
    let cancelled = false;
    (async () => {
      let eta: number | undefined;
      let polyline: string | undefined;
      let steps: LiveSessionRouteStep[] | undefined;
      try {
        if (mode === "train") {
          const res = await computeTransitEta(myLive.lat, myLive.lng, target.lat, target.lng);
          eta = res.etaSeconds;
          polyline = res.polyline || undefined;
          steps = res.steps;
        } else {
          eta = (await fetchRouteDurationSeconds(myLive, target, mode)) ?? undefined;
        }
      } catch {
        // 自動計算の失敗は静かに無視する(参加者一覧の「変更」から手動でやり直せる)。
      }
      if (cancelled) return;
      if (mode === "train") {
        // 電車モードは経路線(routePolyline)を他参加者にも伝える必要があるため
        // transport_updateではなくlocation_update(kind=live)で送る — 既存の
        // transport_updateはpolylineを運べない(2026-08-31実装、§電車経路描画)。
        // 自分自身は自分のブロードキャストを受け取らないため、地図描画用に
        // ローカルのmyTrainRoute stateへも保持しておく。
        setMyTrainRoute(polyline);
        socket.sendLocationUpdate(
          "live",
          { lat: myLive.lat, lng: myLive.lng, accuracy: myLive.accuracy ?? 0 },
          { transportMode: mode, etaSeconds: eta, routePolyline: polyline, routeSteps: steps }
        );
      } else {
        setMyTrainRoute(undefined);
        if (eta !== undefined) socket.sendTransportUpdate(mode, eta);
      }
    })();
    return () => {
      cancelled = true;
    };
    // myLive/targetはオブジェクトとして毎レンダー新規に生成されるため、
    // 依存配列にそのまま入れると値が変わっていなくても(例: 1秒ごとの
    // カウントダウン再レンダー由来で)エフェクトが再実行され、cleanupが
    // 直前の非同期計算を握りつぶしてしまう(常にETAが送信されない不具合の
    // 原因だった、2026-08-31修正)。値そのもの(プリミティブ)を依存にする。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myLive?.lat, myLive?.lng, target?.lat, target?.lng, self?.transportMode]);

  // 招待リンク: ホストはセッション作成時に発行されたshareUrl(ゲスト用共有トークン入り)、
  // ゲストは自分が開いた招待URL自体(ゲスト共有トークンは全員共通のため、
  // そのまま再共有して問題ない)を使う(仕様書§14.4、常時招待)。
  const inviteUrl =
    isHost
      ? shareUrl
      : typeof window !== "undefined"
        ? `${window.location.origin}/?s=${encodeURIComponent(sessionId)}&t=${encodeURIComponent(token)}`
        : undefined;

  // handleEnd: 「共有を終了する」確定時(ホスト、仕様書§5.6)。
  async function handleEnd() {
    setEnding(true);
    setEndError(null);
    try {
      await endSession(sessionId, token);
      clearSession();
      setLocalEnded(true);
    } catch (e) {
      setEnding(false);
      setEndError(e instanceof Error ? e.message : "共有の終了に失敗しました。時間をおいて再度お試しください。");
    }
  }

  // handleLeave: 「退出する」確定時(ゲスト)。自分のWS接続を閉じるだけで、
  // 他の参加者の共有には影響しない(仕様書§5.6)。即座にトップ画面へ戻す
  // のではなく、まずGuestLeftScreen(フィードバック導線あり、2026-08-31改訂)
  // を経由させる — トップ画面への遷移自体はその画面のボタンから行う。
  //
  // socket.disconnect()を明示的に呼ぶ(2026-09-01追加): これを呼ばないと
  // LiveSession自体はアンマウントされない(GuestLeftScreenへの早期return
  // だけ)ため接続が生きたままになり、ホスト側に退出が通知されず・
  // チャットのアクティビティログにも反映されない不具合があった。
  function handleLeave() {
    socket.disconnect();
    clearSession();
    setLocalLeft(true);
  }

  // 目的地変更(ホスト限定、仕様書§9): 現在地を使う/地図タップ/住所検索の
  // いずれかで選んだ新しい地点をlocation_update(kind="target")として
  // サーバーへ送る。他の参加者へは既存のpeer_location(kind="target")配信
  // 経路でそのまま反映され(地図上の目的地ピンが自動的に動く)、トースト
  // 通知も表示される。目的地の新規設定(CreateForm)と全く同じ
  // useDestinationPicker/DestinationPickerPanelを使い、方式によらず
  // 最後に地図タップで微調整・確定できる流れに統一している。
  function openTargetChange() {
    targetPicker.reselect(); // 前回の選択が残っていればクリアしてから開く
    setChangingTarget(true);
  }

  function closeTargetChange() {
    setChangingTarget(false);
  }

  function confirmTargetChange() {
    if (!targetPicker.point) return;
    socket.sendLocationUpdate(
      "target",
      { lat: targetPicker.point.lat, lng: targetPicker.point.lng, accuracy: 0 },
      { address: targetPicker.point.address ?? "" }
    );
    setChangingTarget(false);
  }

  // handleTransportSelect: 移動手段の選択を確定する(TransportModal・ゲスト
  // 参加時の割り込みステップ共通、2026-08-31改訂)。電車モードで既に経路形状
  // (route)が分かっている場合は、それをそのまま送信に使い、かつ
  // autoEtaKeyRef(下記の自動ETA計算エフェクト)へ同じキーを先回りで記録して
  // おく。こうしないと選択直後にself.transportModeの変化を検知した自動計算
  // エフェクトが同じ内容をもう一度取得し直してしまい、NAVITIMEの有料API
  // (route_transit+shape_transit)を無駄に2回消費してしまう。
  function handleTransportSelect(mode: TransportMode, etaSeconds?: number, route?: TrainRouteInfo) {
    if (mode === "train" && myLive && target) {
      autoEtaKeyRef.current = `${mode}|${target.lat.toFixed(5)},${target.lng.toFixed(5)}`;
      setMyTrainRoute(route?.polyline);
      socket.sendLocationUpdate(
        "live",
        { lat: myLive.lat, lng: myLive.lng, accuracy: myLive.accuracy ?? 0 },
        { transportMode: mode, etaSeconds, routePolyline: route?.polyline, routeSteps: route?.steps }
      );
      return;
    }
    setMyTrainRoute(undefined);
    socket.sendTransportUpdate(mode, etaSeconds);
  }

  const ended = localEnded ? { kind: "manual" as const } : socket.ended ? { kind: socket.ended.kind } : null;

  // 参加(再接続)自体が失敗した場合は、役割(host/guest)がまだ判明していない
  // (syncを受け取れていない)ため、SessionEndedScreenのような役割別の
  // 出し分けはできない。共有が既に終了・失効しているという意味では
  // 他の無効リンクと同じなので、一律404を表示する(2026-08-31新設)。
  if (socket.joinFailed) {
    return <NotFoundScreen />;
  }

  // ゲストが自ら退出した場合、専用のGuestLeftScreen(フィードバック導線あり)
  // を挟んでからトップ画面へ戻す(2026-08-31改訂)。
  if (localLeft) {
    return <GuestLeftScreen onBackToTop={() => onLeft?.()} />;
  }

  // セッション終了後は地図に表示すべきものが何も無いため、死んだ地図の上に
  // モーダルを重ねるのではなく、それぞれ専用の全画面表示に切り替える。
  // ホスト（終了させた経緯を知っている）には正式な「終了しました」画面を、
  // ゲスト（リンクしか持っていない）には他の失効リンクと同様の404画面を見せる。
  if (ended) {
    return isHost ? <SessionEndedScreen reason={ended.kind} /> : <NotFoundScreen />;
  }

  const remainingMs = socket.expiresAt ? Date.parse(socket.expiresAt) - now : 0;

  return (
    <div className="cocode-screen">
      <MapView
        target={target}
        participants={liveParticipants}
        recenterSignal={recenterTick}
        fitAllSignal={fitAllTick}
        focusTargetSignal={focusTargetTick}
        pickingTarget={changingTarget && targetPicker.step === "picking"}
        onPickTarget={targetPicker.handleMapPick}
        flyToTargetSignal={targetPicker.flyToSignal}
      />

      <header className="cocode-map-header">
        <span className="cocode-map-header-brand">
          <img src="/brand/logo.png" alt="" className="cocode-map-header-logo" />
          cocode
        </span>
        {socket.expiresAt && (
          <span className={`cocode-map-header-countdown${remainingMs <= 60_000 ? " cocode-countdown-danger" : remainingMs <= 5 * 60_000 ? " cocode-countdown-warn" : ""}`}>
            ⏳ 残り {formatCountdown(remainingMs)}
          </span>
        )}
        <span className="cocode-map-header-count">
          <span className={`cocode-status-dot ${others.length > 0 ? "cocode-status-dot-online" : "cocode-status-dot-offline"}`} />
          {participantCount}人が参加中
        </span>
      </header>

      {toast && <div className="cocode-toast">{toast}</div>}

      {/* 位置情報拒否時の恒常バナー(仕様書§19、2026-08-31実装)。トーストと違い
          自動では消えず、許可されるかタブが閉じられるまで表示し続ける —
          位置情報無しでは自分の現在地を共有できないという状態そのものが
          継続している間、常に気づけるようにするため。 */}
      {myLocationError?.code === "permission_denied" && !myPoint && (
        <div className="cocode-geo-banner" role="alert">
          ⚠️ 位置情報の利用が許可されていません。ブラウザの設定から位置情報の利用を許可すると、あなたの現在地が共有されます。
        </div>
      )}

      {changingTarget && (
        <DestinationPickerPanel
          picker={targetPicker}
          confirmLabel="確定"
          onConfirm={confirmTargetChange}
          onCancelAll={closeTargetChange}
          overlayClassName="cocode-topbar-below-header"
        />
      )}

      <footer className="cocode-map-footer">
        <button className="cocode-map-footer-btn" onClick={() => setShareOpen(true)}>
          <span aria-hidden>🔗</span>
          <span>リンク共有</span>
        </button>
        <button className="cocode-map-footer-btn" onClick={() => setMembersOpen(true)}>
          <span aria-hidden>👥</span>
          <span>メンバー</span>
        </button>
        <button className="cocode-map-footer-btn" onClick={() => setTransportOpen(true)}>
          <span aria-hidden>🚶</span>
          <span>移動手段</span>
        </button>
        <button className="cocode-map-footer-btn" onClick={() => setProfileOpen(true)}>
          <span aria-hidden>✏️</span>
          <span>プロフィール</span>
        </button>
        <button className="cocode-map-footer-btn" onClick={() => setRecenterTick((n) => n + 1)}>
          <span aria-hidden>🎯</span>
          <span>現在地</span>
        </button>
        <button className="cocode-map-footer-btn" onClick={() => setFitAllTick((n) => n + 1)}>
          <span aria-hidden>🗺️</span>
          <span>全員を表示</span>
        </button>
        <button className="cocode-map-footer-btn" onClick={() => setFocusTargetTick((n) => n + 1)}>
          <span aria-hidden>📍</span>
          <span>目的地</span>
        </button>
        <button className="cocode-map-footer-btn" onClick={() => setChatOpen(true)}>
          <span aria-hidden>💬</span>
          <span>チャット</span>
        </button>
        {isHost && (
          <button className="cocode-map-footer-btn" onClick={openTargetChange}>
            <span aria-hidden>🚩</span>
            <span>目的地変更</span>
          </button>
        )}
        <button className="cocode-map-footer-btn cocode-map-footer-btn-danger" onClick={() => setConfirmingEnd(true)}>
          <span aria-hidden>{isHost ? "⏹" : "🚪"}</span>
          <span>{isHost ? "共有停止" : "退出する"}</span>
        </button>
      </footer>

      <MemberSidebar
        open={membersOpen}
        onClose={() => setMembersOpen(false)}
        participants={[...socket.participants.values()]}
        selfParticipantId={socket.selfParticipantId}
        arrivedIds={socket.arrivedIds}
        onChangeTransport={() => {
          setMembersOpen(false);
          setTransportOpen(true);
        }}
      />

      {shareOpen && inviteUrl && <ShareLinkModal shareUrl={inviteUrl} onClose={() => setShareOpen(false)} />}

      {profileOpen && self && (
        <ProfileEditModal
          currentDisplayName={self.displayName}
          currentAvatarIcon={self.avatarIcon}
          onClose={() => setProfileOpen(false)}
          onSave={(displayName, avatarIcon) => {
            socket.sendProfileUpdate(displayName, avatarIcon);
            setProfileOpen(false);
          }}
        />
      )}

      {transportOpen && (
        <TransportModal
          currentMode={self?.transportMode ?? "walk"}
          myLive={myLive}
          target={socket.destination}
          onClose={() => setTransportOpen(false)}
          onSelect={handleTransportSelect}
        />
      )}

      <ChatSidebar
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        activityLog={socket.activityLog}
        onSend={(kind, text) => socket.sendExpression(kind, text)}
      />

      {confirmingEnd && (
        <div className="cocode-modal-backdrop">
          <div className="cocode-glass cocode-modal">
            <div className="cocode-modal-icon">{isHost ? "⏹" : "🚪"}</div>
            <p className="cocode-modal-title">{isHost ? "共有を終了しますか?" : "退出しますか?"}</p>
            <p className="cocode-modal-body">
              {isHost
                ? "終了すると、参加者全員との位置共有がすぐに終わります。この操作は取り消せません。"
                : "あなたはこの共有から退出します。他の参加者の共有はそのまま継続されます。"}
            </p>
            {endError && <p className="cocode-error">{endError}</p>}
            <button className="cocode-btn cocode-btn-primary" onClick={isHost ? handleEnd : handleLeave} disabled={ending}>
              {ending ? "終了中…" : isHost ? "終了する" : "退出する"}
            </button>
            <button
              className="cocode-btn cocode-btn-secondary"
              onClick={() => {
                setConfirmingEnd(false);
                setEndError(null);
              }}
              disabled={ending}
            >
              キャンセル
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
