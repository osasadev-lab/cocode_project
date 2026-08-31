import { useState } from "react";
import { getCurrentPosition, type GeoError } from "./geolocation";
import { searchAddress, type GeocodingResult } from "./geocoding";

export interface DestinationPoint {
  lat: number;
  lng: number;
  address?: string;
}

export type DestinationPickerStep = "choose" | "picking";

// useDestinationPicker: 目的地の指定(新規作成時・変更時で共通、2026-08-31新設)を
// 一箇所にまとめたロジック。現在地を使う/地図から選択する/住所で検索するの
// 3方式をすべて「地図上でタップして微調整・確定する」picking画面へ合流させる
// 一貫した流れにする(CreateForm.tsx・LiveSession.tsxの目的地変更で共用)。
export function useDestinationPicker(initial?: DestinationPoint | null) {
  const [step, setStep] = useState<DestinationPickerStep>("choose");
  const [point, setPointState] = useState<DestinationPoint | null>(initial ?? null);
  const [addressQuery, setAddressQuery] = useState("");
  const [addressResults, setAddressResults] = useState<GeocodingResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // flyToSignal: 値が変わるたびにMapViewへ地図移動(flyTo)を指示するカウンター
  // (2026-08-31新設)。「現在地を使う」/住所検索の候補選択など、地図タップ以外の
  // 方法で地点が決まった場合にインクリメントする(handleMapPickでは地図タップ
  // 自体が既に見ている位置なのでインクリメントしない)。
  const [flyToSignal, setFlyToSignal] = useState(0);

  function setPoint(p: DestinationPoint) {
    setPointState(p);
    setStep("picking");
    setFlyToSignal((n) => n + 1);
  }

  // useCurrentLocation: 現在地を取得し、待ち合わせ地点の候補として採用する。
  async function useCurrentLocation() {
    setError(null);
    setLocating(true);
    try {
      const p = await getCurrentPosition();
      setPoint({ lat: p.lat, lng: p.lng });
    } catch (e) {
      const geoErr = e as GeoError;
      if (geoErr.code === "permission_denied") {
        // 仕様書§19.2-2: 拒否時は他方式への誘導を明示する。
        setError("位置情報の利用が許可されていません。「地図から選択する」または「住所で検索」をお試しください。");
      } else {
        setError(geoErr.message ?? "現在地を取得できませんでした");
      }
    } finally {
      setLocating(false);
    }
  }

  // chooseFromMap: 「地図から選択する」を選んだ場合、地図タップ待ちの状態にする。
  function chooseFromMap() {
    setError(null);
    setStep("picking");
  }

  // runAddressSearch: 住所文字列から候補地点を検索する(仕様書§10)。
  async function runAddressSearch() {
    setError(null);
    setSearching(true);
    try {
      const results = await searchAddress(addressQuery);
      setAddressResults(results);
      if (results.length === 0) setError("該当する住所が見つかりませんでした");
    } catch {
      setError("住所の検索に失敗しました。時間をおいて再度お試しください。");
    } finally {
      setSearching(false);
    }
  }

  // pickAddressResult: 候補を選ぶと、その地点を待ち合わせ地点として採用し
  // picking画面(地図タップで微調整・確定)へ進む。
  function pickAddressResult(r: GeocodingResult) {
    setAddressResults([]);
    setPoint({ lat: r.lat, lng: r.lng, address: r.label });
  }

  // handleMapPick: picking画面での地図タップ(微調整)。住所ラベルは消える。
  function handleMapPick(lat: number, lng: number) {
    setPointState({ lat, lng });
  }

  // reselect: 選択をやり直し、最初の方法選択画面に戻す(地点はクリアする)。
  function reselect() {
    setPointState(null);
    setAddressQuery("");
    setAddressResults([]);
    setError(null);
    setStep("choose");
  }

  return {
    step,
    point,
    addressQuery,
    setAddressQuery,
    addressResults,
    searching,
    locating,
    error,
    flyToSignal,
    useCurrentLocation,
    chooseFromMap,
    runAddressSearch,
    pickAddressResult,
    handleMapPick,
    reselect,
  };
}

export type DestinationPicker = ReturnType<typeof useDestinationPicker>;
