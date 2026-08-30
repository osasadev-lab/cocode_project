package session

import "unicode/utf8"

// MaxDisplayNameLength は表示名の最大文字数（仕様書§6）。
const MaxDisplayNameLength = 20

// ValidAvatarIcons は選択可能なアイコン識別子のホワイトリスト
// （仕様書§6.1で確定した19種、hudPlayer系5種+Enemies系14種）。
var ValidAvatarIcons = map[string]bool{
	"hud_player_beige":   true,
	"hud_player_blue":    true,
	"hud_player_green":   true,
	"hud_player_pink":    true,
	"hud_player_yellow":  true,
	"enemy_barnacle":     true,
	"enemy_bee":          true,
	"enemy_fish_blue":    true,
	"enemy_fish_green":   true,
	"enemy_fish_pink":    true,
	"enemy_fly":          true,
	"enemy_ladybug":      true,
	"enemy_mouse":        true,
	"enemy_slime_blue":   true,
	"enemy_slime_green":  true,
	"enemy_slime_purple": true,
	"enemy_snail":        true,
	"enemy_worm_green":   true,
	"enemy_worm_pink":    true,
}

// ValidDisplayName は表示名が空文字でなく、最大文字数以内であるかを判定する
// （仕様書§6）。重複チェックは行わない（確定）。文字数はUTF-8のルーン数で数える
// （日本語の表示名を想定しており、バイト数ではなく見た目に近い文字数で制限するため）。
func ValidDisplayName(name string) bool {
	if name == "" {
		return false
	}
	return utf8.RuneCountInString(name) <= MaxDisplayNameLength
}

// ValidAvatarIcon はアイコン識別子がホワイトリストに含まれるかを判定する（仕様書§6.1）。
// 重複（複数参加者が同じアイコンを選ぶこと）は許容するため、ここでは判定しない。
func ValidAvatarIcon(icon string) bool {
	return ValidAvatarIcons[icon]
}

// ValidTransportMode は移動手段の識別子が既知の3種に含まれるかを判定する（仕様書§7）。
func ValidTransportMode(mode TransportMode) bool {
	switch mode {
	case TransportWalk, TransportCar, TransportTrain:
		return true
	default:
		return false
	}
}
