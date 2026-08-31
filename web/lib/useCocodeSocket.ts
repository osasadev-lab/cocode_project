import { useCallback, useEffect, useRef, useState } from "react";
import { WS_BASE_URL } from "./config";
import type { GeoPoint } from "./geolocation";
import type {
  ActivityEntry,
  Destination,
  InboundMessage,
  LocationKind,
  ParticipantPublic,
  Role,
  RouteStep,
  TransportMode,
} from "./types";

// アクティビティログ(#5)の保持件数上限。無制限に溜め続けて重くならないよう
// 直近ぶんだけ保持する。
const ACTIVITY_LOG_LIMIT = 30;
let activityIdSeq = 0;
function nextActivityId(): string {
  activityIdSeq += 1;
  return `activity-${activityIdSeq}`;
}
function pushActivity(log: ActivityEntry[], entry: Omit<ActivityEntry, "id">): ActivityEntry[] {
  return [{ ...entry, id: nextActivityId() }, ...log].slice(0, ACTIVITY_LOG_LIMIT);
}

export type ConnectionStatus = "connecting" | "open" | "closed";
export type EndedReason = { kind: "manual" | "ttl" } | null;

// SocketAuth: WS認証フレームに必要な情報。再接続時はparticipantIdのみ、
// 新規参加時はdisplayName/avatarIconのみを渡す（仕様書§5.4、
// server/internal/ws/handler.goのauthFrameに対応）。
//
// announceRejoin(2026-09-01新設): 明示的に「退出する」した後、招待リンクから
// 再入室したゲストの再接続である場合にtrueを渡す(page.tsxのviaGuestIdentity
// 経由の再接続のみが該当)。通常の(ネットワーク瞬断からの)自動再接続では
// 使わない — サーバー側もこのフラグが立った場合のみ他参加者へ
// participant_joinedを再送し、チャットのアクティビティログに
// 「参加しました」を残す。
export type SocketAuth = { token: string } & (
  | { participantId: string; displayName?: undefined; avatarIcon?: undefined; announceRejoin?: boolean }
  | { displayName: string; avatarIcon: string; participantId?: undefined }
);

// CocodeSocketState: セッション接続中にフックが管理する状態全体。
// v1.0のliveA/liveB固定構造から、participantIdをキーにしたマップへ変更した
// （仕様書§5.1の1対多モデルに対応するため）。
interface CocodeSocketState {
  status: ConnectionStatus;
  role: Role | null;
  selfParticipantId: string | null;
  destination: Destination | null;
  expiresAt: string | null;
  participants: Map<string, ParticipantPublic>;
  arrivedIds: Set<string>;
  ended: EndedReason;
  errorMessage: string | null;
  // 直近に切断した参加者(仕様書§0の通知UI用、2026-08-31追加)。同名の参加者が
  // 連続で切断してもUI側のuseEffectが確実に再発火するよう、seqを単調増加させる。
  lastLeft: { participantId: string; displayName: string; seq: number } | null;
  // 右サイドバーのアクティビティログ(参加/退出/到着/ひとことメッセージ、2026-08-31新設)。
  // sync受信時点で既にいたメンバーは含めない(「今から起きたこと」のログ)。
  activityLog: ActivityEntry[];
  // sync前(=join自体)のerrorフレームで true になる(不具合修正§6用、2026-08-31新設)。
  // ゲストの再訪識別ID(localStorage)が既にサーバー側で失効していた場合の
  // フォールバック検知に使う。sync受信で改めてfalseへ戻る。
  joinFailed: boolean;
  // 直近に受信したスタンプ・アイコンリアクション(仕様書§12.1-④⑤、2026-08-31実装)。
  // UI側がトースト等で一時表示するために使う。lastLeftと同じくseqで
  // 同一内容の連続送信でも確実にuseEffectが再発火するようにしている。
  lastExpression: { participantId: string; displayName: string; kind: "stamp" | "reaction"; text: string; seq: number } | null;
}

// 切断時に再接続を試みるまでの待機時間。
const RECONNECT_DELAY_MS = 2000;

function initialState(): CocodeSocketState {
  return {
    status: "connecting",
    role: null,
    selfParticipantId: null,
    destination: null,
    expiresAt: null,
    participants: new Map(),
    arrivedIds: new Set(),
    ended: null,
    errorMessage: null,
    lastLeft: null,
    activityLog: [],
    joinFailed: false,
    lastExpression: null,
  };
}

/**
 * 1つのセッションに対する WebSocket コネクションを管理するフック（仕様書§5.1, §5.4）。
 * 認証フレームの送信、サーバーからのブロードキャストに応じた参加者マップの同期、
 * 自分側の位置情報・移動手段・プロフィール・スタンプ/リアクション送信を行う関数の
 * 提供を行う。
 */
export function useCocodeSocket(sessionId: string | null, auth: SocketAuth | null) {
  const [state, setState] = useState<CocodeSocketState>(initialState);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 「意図的に閉じた（アンマウント、または回復不能なエラー）」かどうかを
  // 追跡し、この場合は自動再接続をしないようにするフラグ。
  const closedByUser = useRef(false);
  // 初回の"sync"を受け取る前かどうか。join自体の失敗によるerrorフレームと、
  // 参加後の個別操作（profile_update等）の拒否によるerrorフレームを区別するために使う
  // （前者のみ致命的で再接続しない、後者は接続を維持したまま呼び出し元へ伝えるだけでよい）。
  const syncedRef = useRef(false);
  // 新規参加(auth.participantId未指定)の場合、最初のsyncで発行されたparticipantIdを
  // 覚えておき、以後の自動再接続ではこちらを使う(2026-08-31修正: このrefが無いと、
  // WS切断のたびに元のauth(displayName/avatarIconのみ、参加時のprops)で再送してしまい、
  // 再接続のたびに新規ゲストとして重複登録されてしまう不具合があった。React
  // StrictMode(開発時)のeffect二重実行や、実際のネットワーク瞬断・復帰猶予タイマー
  // (仕様書§5.6.1)からの再接続いずれでも起こりうる)。
  const joinedParticipantIdRef = useRef<string | null>(null);
  // announceRejoinRef: このマウントの最初の接続確立(sync成功)まではauthの
  // announceRejoinをそのまま送る(接続に何度か失敗して再試行した場合でも、
  // まだ一度も参加できていないので送り続ける)。一度syncに成功したら false に
  // 戻し、以後このマウント内で発生する通常の(ネットワーク瞬断からの)自動
  // 再接続では二度と送らない(2026-09-01新設、SocketAuth.announceRejoin参照)。
  const announceRejoinRef = useRef(false);
  // selfTransportRef: 自分が最後に選んだ移動手段(mode/ETA/電車の経路)を、
  // サーバーが実際に把握しているかどうかに関わらず常にローカルへ保持しておく
  // (2026-09-02新設、不具合修正)。
  //
  // 背景: transport_update/location_updateはfire-and-forgetで送信確認
  // (ACK)を持たない。選択直後にWebSocketが瞬断すると、その1通がサーバーへ
  // 届かないまま再接続することがある。再接続時に届く"sync"フレームは
  // サーバー側の(選択前の)古い移動手段をそのまま返すため、これをそのまま
  // 適用すると「車を選んだのに、後で確認すると別の手段に戻っている」ように
  // 見える不具合が発生していた(ゲスト・ホスト双方で起こりうる — 役割による
  // 分岐が無い共通のsync処理のため)。
  //
  // sync受信時、このrefの値とサーバーが返した値を突き合わせ、ズレていれば
  // ローカルの選択を正として上書きした上で送り直す(下記"sync"ケース参照)。
  const selfTransportRef = useRef<{
    transportMode: TransportMode;
    etaSeconds: number | null;
    routePolyline?: string;
    routeSteps?: RouteStep[];
  } | null>(null);

  useEffect(() => {
    if (!sessionId || !auth) return;
    const currentAuth = auth;
    closedByUser.current = false;
    syncedRef.current = false;
    joinedParticipantIdRef.current = currentAuth.participantId ?? null;
    announceRejoinRef.current = !!(currentAuth.participantId && currentAuth.announceRejoin);
    selfTransportRef.current = null;

    // connect は WebSocket を1本張り、認証・メッセージ受信・再接続を仕込む。
    function connect() {
      const ws = new WebSocket(`${WS_BASE_URL}/ws`);
      wsRef.current = ws;
      setState((s) => ({ ...s, status: "connecting" }));

      // 接続確立後、真っ先に認証フレームを送る。既に一度参加してparticipantIdが
      // 判明していれば、元のauth(新規参加用のdisplayName/avatarIcon)ではなく
      // それを使って再接続する(上記joinedParticipantIdRef参照)。
      ws.onopen = () => {
        const authFrame = joinedParticipantIdRef.current
          ? {
              sessionId,
              token: currentAuth.token,
              participantId: joinedParticipantIdRef.current,
              announceRejoin: announceRejoinRef.current,
            }
          : { sessionId, ...currentAuth };
        ws.send(JSON.stringify(authFrame));
        setState((s) => ({ ...s, status: "open" }));
      };

      // サーバーからのメッセージ種別ごとに状態を更新する。
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data) as InboundMessage;
        switch (msg.type) {
          case "sync": {
            syncedRef.current = true;
            joinedParticipantIdRef.current = msg.participantId;
            // 一度参加できたので、以後このマウント内の自動再接続では
            // announceRejoinを送らない(2026-09-01新設)。
            announceRejoinRef.current = false;
            const participants = new Map<string, ParticipantPublic>();
            const arrivedIds = new Set<string>();
            for (const p of msg.participants) {
              participants.set(p.id, p);
              if (p.arrived) arrivedIds.add(p.id);
            }
            // 移動手段の選択がサーバーに届いていなかった場合の巻き戻り防止
            // (2026-09-02新設、selfTransportRef参照)。まだ何も選んでいなければ
            // (初回sync)、サーバーの値をそのままローカルの基準として記録するだけ。
            const known = selfTransportRef.current;
            const syncedSelf = participants.get(msg.participantId);
            if (syncedSelf) {
              if (!known) {
                selfTransportRef.current = {
                  transportMode: syncedSelf.transportMode,
                  etaSeconds: syncedSelf.etaSeconds,
                  routePolyline: syncedSelf.routePolyline,
                  routeSteps: syncedSelf.routeSteps,
                };
              } else if (known.transportMode !== syncedSelf.transportMode) {
                participants.set(msg.participantId, {
                  ...syncedSelf,
                  transportMode: known.transportMode,
                  etaSeconds: known.etaSeconds,
                  routePolyline: known.routePolyline,
                  routeSteps: known.routeSteps,
                });
                if (known.transportMode === "train" && syncedSelf.live) {
                  send({
                    type: "location_update",
                    kind: "live",
                    lat: syncedSelf.live.lat,
                    lng: syncedSelf.live.lng,
                    accuracy: syncedSelf.live.accuracy,
                    transportMode: known.transportMode,
                    etaSeconds: known.etaSeconds ?? undefined,
                    routePolyline: known.routePolyline,
                    routeSteps: known.routeSteps,
                  });
                } else {
                  send({ type: "transport_update", transportMode: known.transportMode, etaSeconds: known.etaSeconds ?? undefined });
                }
              }
            }
            setState((s) => ({
              ...s,
              role: msg.role,
              selfParticipantId: msg.participantId,
              destination: msg.destination,
              expiresAt: msg.expiresAt,
              participants,
              arrivedIds,
              errorMessage: null,
              joinFailed: false,
            }));
            break;
          }
          case "participant_joined":
            setState((s) => {
              const participants = new Map(s.participants);
              participants.set(msg.participant.id, {
                id: msg.participant.id,
                role: msg.participant.role,
                displayName: msg.participant.displayName,
                avatarIcon: msg.participant.avatarIcon,
                transportMode: msg.participant.transportMode,
                live: null,
                etaSeconds: null,
                arrived: false,
              });
              return {
                ...s,
                participants,
                activityLog: pushActivity(s.activityLog, { kind: "joined", displayName: msg.participant.displayName, at: new Date().toISOString() }),
              };
            });
            break;
          case "participant_left":
            setState((s) => {
              const participants = new Map(s.participants);
              participants.delete(msg.participantId);
              // arrivedIdsはここでは消さない(2026-08-31修正): 到着はサーバー側で
              // 一度成立したら恒久的な事実(hub.goのArrivedAtはnilに戻らない)なので、
              // 一時的な回線切断・再接続(再接続時はparticipant_joinedが飛ばない
              // 仕様)ごとに到着バッジが消えてしまうのを防ぐ。
              return {
                ...s,
                participants,
                lastLeft: { participantId: msg.participantId, displayName: msg.displayName, seq: (s.lastLeft?.seq ?? 0) + 1 },
                activityLog: pushActivity(s.activityLog, { kind: "left", displayName: msg.displayName, at: new Date().toISOString() }),
              };
            });
            break;
          case "peer_location":
            setState((s) => {
              if (msg.kind === "target") {
                return { ...s, destination: { lat: msg.lat, lng: msg.lng, address: msg.address, updatedAt: msg.updatedAt } };
              }
              const existing = s.participants.get(msg.participantId);
              // 電車モードの経路線(2026-08-31実装)。実際のGPS位置更新は
              // 移動手段の変更とは独立して頻繁に届く(上記の「自分の位置が
              // 変化した時」エフェクト参照)ため、その都度の更新にはpolylineが
              // 含まれない(サーバー側でomitempty)。電車モードのまま届いた
              // 単なる位置更新でpolylineを毎回undefinedにしてしまうと、
              // 数秒おきに地図上の電車経路線が消えてしまう。移動手段が
              // 電車のまま・かつ今回の更新にpolylineが無い場合は直前の値を
              // 保持し、電車以外に変わった/新しいpolylineが届いた場合のみ
              // 更新する。
              const keepPreviousRoute = msg.transportMode === "train" && !msg.routePolyline && existing?.transportMode === "train";
              const updated: ParticipantPublic = {
                id: msg.participantId,
                role: msg.role,
                displayName: msg.displayName,
                avatarIcon: msg.avatarIcon,
                transportMode: msg.transportMode,
                etaSeconds: msg.etaSeconds,
                live: { lat: msg.lat, lng: msg.lng, accuracy: msg.accuracy, updatedAt: msg.updatedAt },
                arrived: existing?.arrived ?? s.arrivedIds.has(msg.participantId),
                routePolyline: keepPreviousRoute ? existing?.routePolyline : msg.routePolyline,
                routeSteps: keepPreviousRoute ? existing?.routeSteps : msg.routeSteps,
              };
              const participants = new Map(s.participants);
              participants.set(msg.participantId, existing ? { ...existing, ...updated } : updated);
              return { ...s, participants };
            });
            break;
          case "participant_updated":
            setState((s) => {
              const existing = s.participants.get(msg.participantId);
              if (!existing) return s;
              const participants = new Map(s.participants);
              participants.set(msg.participantId, {
                ...existing,
                displayName: msg.displayName,
                avatarIcon: msg.avatarIcon,
              });
              return { ...s, participants };
            });
            break;
          case "participant_arrived":
            setState((s) => {
              const arrivedIds = new Set(s.arrivedIds);
              arrivedIds.add(msg.participantId);
              return {
                ...s,
                arrivedIds,
                activityLog: pushActivity(s.activityLog, { kind: "arrived", displayName: msg.displayName, at: msg.arrivedAt }),
              };
            });
            break;
          case "peer_expression":
            // スタンプ・アイコンリアクションの表示(仕様書§12.1-④⑤、2026-08-31実装)。
            // lastExpressionへ保持し、UI側(LiveSession.tsx)がトースト等で
            // 一時的に表示する。ひとことメッセージ(kind=stamp・text付き)だけは
            // アクティビティログにも残す(2026-08-31新設、#5)。
            setState((s) => ({
              ...s,
              lastExpression: {
                participantId: msg.participantId,
                displayName: msg.displayName,
                kind: msg.kind,
                text: msg.text,
                seq: (s.lastExpression?.seq ?? 0) + 1,
              },
              activityLog:
                msg.kind === "stamp" && msg.text.trim() !== ""
                  ? pushActivity(s.activityLog, { kind: "message", displayName: msg.displayName, text: msg.text, at: msg.sentAt })
                  : s.activityLog,
            }));
            break;
          case "session_ended":
            setState((s) => ({ ...s, ended: { kind: "manual" } }));
            break;
          case "session_expired":
            setState((s) => ({ ...s, ended: { kind: "ttl" } }));
            break;
          case "error": {
            const isJoinFailure = !syncedRef.current;
            if (isJoinFailure) {
              // sync前のerror = join自体の失敗。再接続しても無駄なので諦める。
              closedByUser.current = true;
            }
            setState((s) => ({ ...s, errorMessage: msg.message, joinFailed: s.joinFailed || isJoinFailure }));
            break;
          }
        }
      };

      // 切断時、意図的な切断でなければ一定時間後に再接続を試みる。
      //
      // ws !== wsRef.current のチェックが必須(2026-08-31修正): React
      // StrictMode(開発時)はマウント時にeffectを一度クリーンアップしてから
      // 再実行する(mount→cleanup→remount)。このクリーンアップはclosedByUser
      // を true にしてから ws を close() するが、closedByUser は全ての
      // connect() 呼び出しで共有される1つのrefのため、直後に再実行された
      // effect が(2回目のconnect()内で)closedByUserをfalseへ戻してしまう。
      // すると1回目のws(既にclose済み)のoncloseが後から非同期に発火した際、
      // 「意図的な切断ではない」と誤判定して再接続してしまい、正常に動いている
      // 2回目のwsをprev.Close()で奪って強制切断する—という、2秒(再接続間隔)
      // ごとに永遠に接続を奪い合うループが発生していた。「このoncloseが対象と
      // するwsが今も現役(wsRef.current)かどうか」で判定すれば、閉じられた側の
      // 古いwsは自分がもう不要になったことを正しく認識できる。
      ws.onclose = () => {
        if (ws !== wsRef.current) return;
        setState((s) => ({ ...s, status: "closed" }));
        if (closedByUser.current) return;
        reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY_MS);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    // クリーンアップ: アンマウント/依存値変更時は再接続させずに接続を閉じる。
    // wsRef.current を null に戻すのは、上のonclose内の「ws !== wsRef.current」
    // 判定を正しく機能させるため(このwsは二度と「現役」に一致しなくなる)。
    return () => {
      closedByUser.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      wsRef.current = null;
      setState(initialState());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, auth?.token, auth?.participantId, auth?.displayName, auth?.avatarIcon]);

  function send(payload: unknown) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }

  // disconnect はWebSocket接続を明示的に閉じ、自動再接続もさせない
  // (2026-09-01新設)。ゲストの「退出する」操作用: これを呼ばずに単に
  // 別画面(GuestLeftScreen)へ切り替えるだけだと、useCocodeSocketのフック
  // 自体はマウントされたまま(LiveSessionコンポーネントは早期returnして
  // いるだけでアンマウントされない)接続が生き続けてしまい、サーバー側の
  // hub.Disconnectが呼ばれず、他の参加者(ホスト等)に退出が通知され
  // ない・チャットのアクティビティログにも残らない、という不具合があった。
  const disconnect = useCallback(() => {
    closedByUser.current = true;
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    wsRef.current?.close();
  }, []);

  // sendLocationUpdate は自分側の位置情報更新をサーバーへ送信する。
  // extraは電車モードのETA・経路等、kind="live"の場合のみ意味を持つ(仕様書§7.1.1)。
  //
  // kind="target"の場合、サーバーは送信者自身にはブロードキャストを返さない
  // (hub.UpdateLocationのotherConnsは自分を含まない)。そのままだと目的地
  // 変更操作をしたホスト自身の画面にだけ変更が反映されないため、ここで
  // 楽観的に自分のdestination状態も更新しておく(2026-08-31追加)。
  //
  // kind="live"でtransportMode等のextraを伴う場合も同様の理由で、自分の
  // participants状態を楽観的に更新する(2026-08-31修正: 電車モードは
  // sendTransportUpdateではなくこちら経由で送る(経路線を運ぶため)ため、
  // sendTransportUpdateが持っていた自分自身への楽観的反映が無く、電車を
  // 選択しても自分の参加者一覧の表示・地図上の自分の経路が反映されない
  // 不具合があった)。extraにtransportModeが無い、単なる位置の再送信
  // (LiveSession.tsxの「自分の位置が変化した時」エフェクト)では
  // 何も上書きしない — 直前に選んだ移動手段の表示を消してしまわないため。
  const sendLocationUpdate = useCallback(
    (
      kind: LocationKind,
      point: GeoPoint,
      extra?: { address?: string; transportMode?: TransportMode; etaSeconds?: number; routePolyline?: string; routeSteps?: RouteStep[] }
    ) => {
      send({
        type: "location_update",
        kind,
        lat: point.lat,
        lng: point.lng,
        accuracy: point.accuracy,
        ...extra,
      });
      if (kind === "target") {
        setState((s) => ({
          ...s,
          destination: { lat: point.lat, lng: point.lng, address: extra?.address, updatedAt: new Date().toISOString() },
        }));
      } else if (kind === "live" && extra?.transportMode) {
        // selfTransportRefも合わせて更新する(2026-09-02新設、"sync"ケース参照)。
        // 再接続時にサーバーがこの選択より古い移動手段を返してきた場合の
        // 巻き戻り検知・補正に使う。
        selfTransportRef.current = {
          transportMode: extra.transportMode,
          etaSeconds: extra.etaSeconds ?? null,
          routePolyline: extra.routePolyline,
          routeSteps: extra.routeSteps,
        };
        setState((s) => {
          if (!s.selfParticipantId) return s;
          const existing = s.participants.get(s.selfParticipantId);
          if (!existing) return s;
          const participants = new Map(s.participants);
          participants.set(s.selfParticipantId, {
            ...existing,
            transportMode: extra.transportMode!,
            etaSeconds: extra.etaSeconds ?? null,
            routePolyline: extra.routePolyline,
            routeSteps: extra.routeSteps,
          });
          return { ...s, participants };
        });
      }
    },
    []
  );

  // sendTransportUpdate は移動手段のみの変更(GPS更新を伴わない)を送信する(仕様書§7)。
  //
  // location_update(kind="target")と同様、サーバーはこのブロードキャストを
  // 送信者自身には返さない(hub.UpdateTransportのotherConnsも自分を含まない。
  // さらにライブ位置未送信の間は誰にも配信しない)。そのままだと自分の
  // 移動手段・ETAが自分のparticipants状態に反映されず、参加者一覧に
  // 自分のETAが表示されない不具合になるため、ここで楽観的に反映する
  // (2026-08-31追加)。
  const sendTransportUpdate = useCallback((transportMode: TransportMode, etaSeconds?: number) => {
    send({ type: "transport_update", transportMode, etaSeconds });
    // selfTransportRefも合わせて更新する(2026-09-02新設、sendLocationUpdate・
    // "sync"ケース参照)。
    selfTransportRef.current = { transportMode, etaSeconds: etaSeconds ?? null, routePolyline: undefined, routeSteps: undefined };
    setState((s) => {
      if (!s.selfParticipantId) return s;
      const existing = s.participants.get(s.selfParticipantId);
      if (!existing) return s;
      const participants = new Map(s.participants);
      participants.set(s.selfParticipantId, { ...existing, transportMode, etaSeconds: etaSeconds ?? null });
      return { ...s, participants };
    });
  }, []);

  // sendProfileUpdate は共有中の表示名・アイコン変更を送信する(仕様書§14.5)。
  //
  // sendTransportUpdate/sendLocationUpdate(kind="target")と同様、サーバーは
  // このブロードキャストを送信者自身には返さない(hub.UpdateProfileの
  // otherConnsも自分を含まない)。そのままだと自分の変更が自分の参加者一覧・
  // 地図マーカーに反映されないため、ここで楽観的に反映する(2026-08-31追加)。
  const sendProfileUpdate = useCallback((displayName: string, avatarIcon: string) => {
    send({ type: "profile_update", displayName, avatarIcon });
    setState((s) => {
      if (!s.selfParticipantId) return s;
      const existing = s.participants.get(s.selfParticipantId);
      if (!existing) return s;
      const participants = new Map(s.participants);
      participants.set(s.selfParticipantId, { ...existing, displayName, avatarIcon });
      return { ...s, participants };
    });
  }, []);

  // sendExpression はスタンプ・アイコンリアクションを送信する(仕様書§12.1-④⑤)。
  // サーバーは送信者自身にはpeer_expressionを返さない(他参加者のみへ配信)ため、
  // ひとことメッセージ(kind=stamp・text付き)は自分のアクティビティログにも
  // 楽観的に追加しておく(2026-08-31実装、#5)。
  const sendExpression = useCallback((kind: "stamp" | "reaction", text?: string) => {
    send({ type: "expression", kind, text });
    if (kind === "stamp" && text && text.trim() !== "") {
      setState((s) => {
        const displayName = (s.selfParticipantId && s.participants.get(s.selfParticipantId)?.displayName) || "あなた";
        return { ...s, activityLog: pushActivity(s.activityLog, { kind: "message", displayName, text, at: new Date().toISOString() }) };
      });
    }
  }, []);

  return { ...state, sendLocationUpdate, sendTransportUpdate, sendProfileUpdate, sendExpression, disconnect };
}
