"use client";

import { useEffect, useRef } from "react";
import { ADSENSE_CLIENT_ID, ADSENSE_SLOT_ID } from "@/lib/config";

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

// AdSlot: ホスト用/ゲスト用トップページの広告エリア(仕様書§15.1)。
// パブリッシャーID(ADSENSE_CLIENT_ID)未設定の間は既存の空プレースホルダーの
// ままにし(位置情報共有・入力画面等、この2画面以外には設置しない方針との
// 整合を保つため見た目も変えない)、設定され次第このコンポーネントの
// 差し替えだけで実際の広告に切り替わる。
export function AdSlot() {
  const insRef = useRef<HTMLModElement>(null);
  const pushedRef = useRef(false);

  useEffect(() => {
    if (!ADSENSE_CLIENT_ID || !ADSENSE_SLOT_ID || pushedRef.current) return;
    pushedRef.current = true;
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch {
      // 広告ブロッカー等でスクリプト自体が読み込まれていない場合は静かに無視する
      // (フィードバックメール未設定時と同様、他機能に影響させない)。
    }
  }, []);

  if (!ADSENSE_CLIENT_ID || !ADSENSE_SLOT_ID) {
    return <div className="cocode-ad-placeholder" aria-hidden />;
  }

  return (
    <ins
      ref={insRef}
      className="adsbygoogle cocode-ad-placeholder"
      style={{ display: "block" }}
      data-ad-client={ADSENSE_CLIENT_ID}
      data-ad-slot={ADSENSE_SLOT_ID}
      data-ad-format="auto"
      data-full-width-responsive="true"
    />
  );
}
