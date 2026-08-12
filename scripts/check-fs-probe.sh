#!/bin/sh
# 判读 fs-probe.sh 的输出（计划书 §8.4、§8.8 门槛 3）。
#
# 单独成文件而不是写在工作流的 script 块里，是因为
# android-emulator-runner 会把 script **逐行**交给 sh 执行——跨多行的
# `if ... fi` 或带引号的命令会在第一行就断掉，而断掉的表现是
# "Syntax error" 加一个非零退出码，看起来像是探测失败而不是脚本写错。
# 我在这上面栽了两次，所以把它挪进文件。
#
# 用法：sh check-fs-probe.sh <probe 输出文件> <平台名>

set -u
FILE="${1:-}"
LABEL="${2:-unknown}"
[ -f "$FILE" ] || { echo "找不到探针输出：$FILE" >&2; exit 2; }

val() { sed -n "s/^$1=//p" "$FILE" | head -1; }
fail=0
note() { echo "  $*"; }

echo "===== $LABEL 文件系统语义判读 ====="
cat "$FILE"
echo "-----------------------------------"

# --- 1. 探针必须真的跑完 ---
# "没测"绝不能表现为"通过"：这一格的全部价值就在于它会在没测到时变红
if [ "$(val PROBE_OK)" != "1" ]; then
	echo "✗ 探针未跑完（缺少 PROBE_OK=1）"
	fail=1
fi
if grep -q '^PROBE_ERROR=' "$FILE"; then
	echo "✗ 探针报错：$(val PROBE_ERROR)"
	fail=1
fi
if grep -q 'unwritable' "$FILE"; then
	echo "✗ 有检查项因目标不可写而未完成："
	grep 'unwritable' "$FILE" | sed 's/^/    /'
	fail=1
fi

# --- 2. 最危险的一条：文件系统碰撞而我们的规则没覆盖 ---
#
# platformCollisionKey 是平台无关的最保守判定：总是小写化、去尾随点与空格、
# NFC 归一。因此下面这三类碰撞它**一定**预言得到——
# 无论文件系统答 yes 还是 no，我们都不会比现实宽松。
#
# 这里仍然逐条检查，是为了给将来新增的探测项留一个必须填的位置：
# 加了一个探测项却没在这里判读，等于加了一个没人看的数字。
for k in CASE_INSENSITIVE UNICODE_NORMALIZING TRAILING_DOT_COLLIDES TRAILING_SPACE_COLLIDES; do
	v=$(val "$k")
	case "$v" in
		yes) note "· $k=yes —— 规则已覆盖（小写化 / NFC 归一 / 去尾随点空格），不会静默覆盖" ;;
		no)  note "· $k=no  —— 规则比现实更严，只会多拦一次，安全" ;;
		"")  echo "✗ $k 未测出"; fail=1 ;;
		*)   echo "✗ $k 值异常：$v"; fail=1 ;;
	esac
done

# --- 3. 原子安装能力（§8.8 门槛 11） ---
#
# LocalCommitter 的安装流程是「先把旧内容挪进 recovery，再把 staging 改名过来」，
# 因此依赖的是 RENAME_TO_FREE，**不是** RENAME_OVER_EXISTING。
# 后者只作记录：Windows 上它是 no，而 Windows 的安装完全正常。
case "$(val RENAME_TO_FREE)" in
	yes) note "· 支持原子安装（rename 到空位）" ;;
	no)  note "· 不支持原子安装 → 覆盖类写入退化为 keep-both（门槛 11 的既定行为）" ;;
	*)   echo "✗ RENAME_TO_FREE 未测出"; fail=1 ;;
esac
note "· RENAME_OVER_EXISTING=$(val RENAME_OVER_EXISTING)（仅记录；安装流程不依赖它）"

echo "-----------------------------------"
if [ "$fail" -ne 0 ]; then
	echo "✗ $LABEL：这一格不算通过"
	exit 1
fi
echo "✓ $LABEL：文件系统语义已取证，且与我们的碰撞规则不冲突"
