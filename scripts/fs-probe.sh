#!/bin/sh
# 文件系统语义探针（计划书 §8.4 实机矩阵）。
#
# 用最小依赖的 POSIX sh 实现，因为它要在这些地方跑：
#   - Linux / WSL（有 Node，但这个探针不需要）
#   - **Android 的 adb shell**（没有 Node，也装不了）
#   - macOS（有 Node，CI 已覆盖，这里作为交叉验证）
#
# 为什么需要它：tests/realfs.test.ts 依赖 Node，而 Android 上没有 Node。
# Obsidian Mobile 本身没法在 CI 里跑，但**文件系统语义**可以单独取证——
# 而碰撞规则的正确性恰恰只取决于文件系统，不取决于 Obsidian。
#
# 它验证的是最危险的那条假设：我们以为两个名字不同、文件系统认为相同，
# 于是后写的静默覆盖先写的。
#
# 用法：  sh fs-probe.sh <可写目录>
# 输出：  每行 "KEY=VALUE"，便于机器判读

set -u
DIR="${1:-}"
if [ -z "$DIR" ]; then
	echo "用法: sh fs-probe.sh <可写目录>" >&2
	exit 2
fi
mkdir -p "$DIR" 2>/dev/null || { echo "无法创建 $DIR" >&2; exit 2; }
WORK="$DIR/litesync-fsprobe.$$"
mkdir -p "$WORK" || { echo "无法创建 $WORK" >&2; exit 2; }
# shellcheck disable=SC2064
trap "rm -rf '$WORK' 2>/dev/null" EXIT INT TERM

# same_file A B —— 写 A、读 B，读得到且内容一致则认为是同一个文件
same_file() {
	rm -f "$WORK/$1" "$WORK/$2" 2>/dev/null
	( printf 'probe-a' > "$WORK/$1" ) 2>/dev/null || { echo "unwritable"; return; }
	if [ -f "$WORK/$2" ] && [ "$(cat "$WORK/$2" 2>/dev/null)" = "probe-a" ]; then
		echo "yes"
	else
		echo "no"
	fi
	rm -f "$WORK/$1" "$WORK/$2" 2>/dev/null
}

# can_create NAME
can_create() {
	rm -f "$WORK/$1" 2>/dev/null
	# 括号包住：重定向本身失败时的报错由 shell 发出，命令级的 2>/dev/null 拦不住
	if ( printf 'x' > "$WORK/$1" ) 2>/dev/null && [ -f "$WORK/$1" ]; then
		echo "yes"
	else
		echo "no"
	fi
	rm -f "$WORK/$1" 2>/dev/null
}

echo "PROBE_VERSION=1"
echo "UNAME=$(uname -a 2>/dev/null | tr ' ' '_' || echo unknown)"
echo "TARGET_DIR=$DIR"

# --- 大小写敏感性：最危险的一格 ---
echo "CASE_INSENSITIVE=$(same_file 'Note.md' 'note.md')"

# --- Unicode NFC / NFD ---
# café.md：第一个是 NFC（U+00E9），第二个是 NFD（e + U+0301）
NFC=$(printf 'caf\303\251.md')
NFD=$(printf 'cafe\314\201.md')
echo "UNICODE_NORMALIZING=$(same_file "$NFC" "$NFD")"

# --- 尾随点 / 尾随空格 ---
echo "TRAILING_DOT_COLLIDES=$(same_file 'note.md' 'note.md.')"
echo "TRAILING_SPACE_COLLIDES=$(same_file 'note.md' 'note.md ')"
echo "CAN_CREATE_TRAILING_DOT=$(can_create 'trailing.')"
echo "CAN_CREATE_TRAILING_SPACE=$(can_create 'trailing ')"

# --- Windows 保留名 ---
echo "CAN_CREATE_CON=$(can_create 'CON.md')"
echo "CAN_CREATE_NUL=$(can_create 'NUL.md')"

# --- 超长组件 ---
LONG=$(printf 'x%.0s' $(seq 1 300) 2>/dev/null || echo "")
if [ -n "$LONG" ]; then
	echo "CAN_CREATE_300CHAR=$(can_create "$LONG.md")"
else
	echo "CAN_CREATE_300CHAR=skipped"
fi

# --- rename 语义：LocalCommitter 的安装依赖它 ---
# 1) 改名到空位（安装流程真正用到的操作）
rm -f "$WORK/ra" "$WORK/rb" 2>/dev/null
printf 'A' > "$WORK/ra" 2>/dev/null
if mv "$WORK/ra" "$WORK/rb" 2>/dev/null && [ "$(cat "$WORK/rb" 2>/dev/null)" = "A" ]; then
	echo "RENAME_TO_FREE=yes"
else
	echo "RENAME_TO_FREE=no"
fi
rm -f "$WORK/ra" "$WORK/rb" 2>/dev/null

# 2) 改名覆盖已存在的文件（安装流程**不**依赖它；记录供参考）
printf 'A' > "$WORK/ra" 2>/dev/null
printf 'B' > "$WORK/rb" 2>/dev/null
if mv "$WORK/ra" "$WORK/rb" 2>/dev/null && [ "$(cat "$WORK/rb" 2>/dev/null)" = "A" ]; then
	echo "RENAME_OVER_EXISTING=yes"
else
	echo "RENAME_OVER_EXISTING=no"
fi
rm -f "$WORK/ra" "$WORK/rb" 2>/dev/null

echo "PROBE_OK=1"
