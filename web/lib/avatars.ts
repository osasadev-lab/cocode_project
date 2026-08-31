// server/internal/session/validation.go の ValidAvatarIcons(§6.1で確定した19種)と
// 1対1で対応する識別子・日本語ラベル・画像パスの一覧。
//
// 画像本体はKenneyアセット(docs/cocode/version/2.0/kenney_platformer-pack-remastered/)
// から web/public/avatars/ へコピー済み(2026-08-31、識別子と同じファイル名に正規化)。
export const AVATAR_ICONS: { id: string; label: string; src: string }[] = [
  { id: "hud_player_beige", label: "プレイヤー(ベージュ)", src: "/avatars/hud_player_beige.png" },
  { id: "hud_player_blue", label: "プレイヤー(ブルー)", src: "/avatars/hud_player_blue.png" },
  { id: "hud_player_green", label: "プレイヤー(グリーン)", src: "/avatars/hud_player_green.png" },
  { id: "hud_player_pink", label: "プレイヤー(ピンク)", src: "/avatars/hud_player_pink.png" },
  { id: "hud_player_yellow", label: "プレイヤー(イエロー)", src: "/avatars/hud_player_yellow.png" },
  { id: "enemy_barnacle", label: "フジツボ", src: "/avatars/enemy_barnacle.png" },
  { id: "enemy_bee", label: "ハチ", src: "/avatars/enemy_bee.png" },
  { id: "enemy_fish_blue", label: "サカナ(ブルー)", src: "/avatars/enemy_fish_blue.png" },
  { id: "enemy_fish_green", label: "サカナ(グリーン)", src: "/avatars/enemy_fish_green.png" },
  { id: "enemy_fish_pink", label: "サカナ(ピンク)", src: "/avatars/enemy_fish_pink.png" },
  { id: "enemy_fly", label: "ハエ", src: "/avatars/enemy_fly.png" },
  { id: "enemy_ladybug", label: "テントウムシ", src: "/avatars/enemy_ladybug.png" },
  { id: "enemy_mouse", label: "ネズミ", src: "/avatars/enemy_mouse.png" },
  { id: "enemy_slime_blue", label: "スライム(ブルー)", src: "/avatars/enemy_slime_blue.png" },
  { id: "enemy_slime_green", label: "スライム(グリーン)", src: "/avatars/enemy_slime_green.png" },
  { id: "enemy_slime_purple", label: "スライム(パープル)", src: "/avatars/enemy_slime_purple.png" },
  { id: "enemy_snail", label: "カタツムリ", src: "/avatars/enemy_snail.png" },
  { id: "enemy_worm_green", label: "イモムシ(グリーン)", src: "/avatars/enemy_worm_green.png" },
  { id: "enemy_worm_pink", label: "イモムシ(ピンク)", src: "/avatars/enemy_worm_pink.png" },
];

export const DEFAULT_AVATAR_ICON = AVATAR_ICONS[0].id;

const ICON_MAP = new Map(AVATAR_ICONS.map((a) => [a.id, a]));

// avatarIconSrc: 識別子から画像パスを引く。未知の識別子(想定外のデータ)の
// 場合は既定アイコンにフォールバックする。
export function avatarIconSrc(id: string): string {
  return ICON_MAP.get(id)?.src ?? AVATAR_ICONS[0].src;
}
