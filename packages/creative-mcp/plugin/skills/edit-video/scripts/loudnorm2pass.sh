#!/usr/bin/env bash
# Two-pass EBU R128 loudness normalisation with ffmpeg's loudnorm, then a verification scan.
#
#   loudnorm2pass.sh IN OUT [TARGET_LUFS=-14] [TRUE_PEAK_DBTP=-1] [LRA=11]
#
# Targets: -14 LUFS / -1 dBTP for social video and music; -16 LUFS / -1.5 dBTP for voice/podcast.
# Video (if any) is stream-copied. Audio codec follows OUT's extension:
#   .wav -> PCM 24-bit 48 kHz   .m4a/.mp4/.mov -> AAC 256k 48 kHz   .mp3 -> 320k   other -> ffmpeg default.
set -euo pipefail

if [[ $# -lt 2 ]]; then
  sed -n '2,8p' "$0"; exit 2
fi
IN=$1; OUT=$2; I=${3:--14}; TP=${4:--1}; LRA=${5:-11}
[[ -e "$OUT" ]] && { echo "refusing to overwrite $OUT" >&2; exit 1; }

# Pass 1: measure. loudnorm prints its JSON block at the end of stderr.
MEASURE=$(ffmpeg -hide_banner -nostats -i "$IN" -vn -af "loudnorm=I=$I:TP=$TP:LRA=$LRA:print_format=json" -f null - 2>&1 \
  | awk '/^\{/{on=1} on{print} /^\}/{on=0}')
get() { printf '%s' "$MEASURE" | python3 -c "import json,sys; print(json.load(sys.stdin)['$1'])"; }
MI=$(get input_i); MTP=$(get input_tp); MLRA=$(get input_lra); MTH=$(get input_thresh); OFF=$(get target_offset)
echo "measured: I=$MI LUFS  TP=$MTP dBTP  LRA=$MLRA  thresh=$MTH  offset=$OFF"
if [[ "$MI" == "-inf" ]]; then echo "input is silent; nothing to normalise" >&2; exit 1; fi

case "${OUT##*.}" in
  wav)          ACODEC=(-c:a pcm_s24le) ;;
  m4a|mp4|mov)  ACODEC=(-c:a aac -b:a 256k) ;;
  mp3)          ACODEC=(-c:a libmp3lame -b:a 320k) ;;
  *)            ACODEC=() ;;
esac
VIDEO=(-vn)
if ffprobe -v error -select_streams v:0 -show_entries stream=codec_type -of csv=p=0 "$IN" | grep -q video \
   && [[ "${OUT##*.}" =~ ^(mp4|mov|mkv)$ ]]; then
  VIDEO=(-map 0:v:0 -c:v copy)
fi

# Pass 2: apply with the measured values (linear mode keeps dynamics when possible).
# loudnorm resamples to 192 kHz internally, so force 48 kHz on output.
MUX=()
[[ "${OUT##*.}" =~ ^(mp4|mov|m4a)$ ]] && MUX=(-movflags +faststart)
ffmpeg -hide_banner -loglevel error -i "$IN" "${VIDEO[@]}" -map 0:a:0 \
  -af "loudnorm=I=$I:TP=$TP:LRA=$LRA:measured_I=$MI:measured_TP=$MTP:measured_LRA=$MLRA:measured_thresh=$MTH:offset=$OFF:linear=true" \
  -ar 48000 ${ACODEC[@]+"${ACODEC[@]}"} ${MUX[@]+"${MUX[@]}"} "$OUT"

# Verify with an independent ebur128 scan. loudnorm's pass-1 numbers can be wrong on bursty or very
# dynamic material, so never trust the result silently.
REPORT=$(ffmpeg -hide_banner -nostats -i "$OUT" -vn -af ebur128=peak=true -f null - 2>&1 \
  | awk '/Summary:/{on=1} on && /(I:|LRA:|Peak:)/{gsub(/^ +/,""); print}')
printf '%s\n' "$REPORT" | sed 's/^/result:   /'
RI=$(printf '%s\n' "$REPORT" | awk '/^I:/{print $2}')
RTP=$(printf '%s\n' "$REPORT" | awk '/^Peak:/{print $2}')
if awk -v r="$RI" -v t="$I" -v p="$RTP" -v tp="$TP" 'BEGIN{d=r-t; if(d<0)d=-d; exit !(d<=1 && p<=tp+0.3)}'; then
  echo "PASS: within 1 LU of $I LUFS and true peak <= $TP dBTP"
else
  echo "WARN: got $RI LUFS / $RTP dBTP, target $I LUFS / $TP dBTP." >&2
  echo "      Fix: keep the default LRA (lets loudnorm switch to dynamic mode), or correct by gain:" >&2
  echo "      ffmpeg -i $OUT -af volume=<(target)-(result)>dB,alimiter=limit=0.85:level=false -ar 48000 <new file>" >&2
  echo "      then re-measure with ebur128. Re-running loudnorm on the output repeats the same mis-measurement." >&2
  exit 3
fi
