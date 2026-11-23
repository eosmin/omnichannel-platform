#!/bin/sh
# Makes the fixtures of the video and audio cleaner: tiny clips (one second or less) that carry a fake place, a time, a model and a name on
# purpose. Nothing here is real data. Needs docker; the full ffmpeg of Alpine is used only to MAKE the files (the worker image has no encoder).
#   sh generate.sh
set -eu
cd "$(dirname "$0")"
docker run --rm -v "$PWD:/out" alpine:3.22 sh -c '
apk add --no-cache ffmpeg >/dev/null
cd /out
M="-metadata location=+40.7128-074.0060/ -metadata com.apple.quicktime.location.ISO6709=+40.7128-074.0060/ -metadata creation_time=2024-05-01T10:00:00Z -metadata model=PhoneX -metadata artist=Someone -metadata comment=secret"
ffmpeg -y -loglevel error -f lavfi -i testsrc=size=64x64:rate=5:duration=1 -f lavfi -i sine=d=1 -c:v libx264 -pix_fmt yuv420p -c:a aac $M -metadata:s:v creation_time=2024-05-01T10:00:00Z -metadata:s:v handler_name=SecretHandler -movflags use_metadata_tags dirty.mp4
ffmpeg -y -loglevel error -i dirty.mp4 -c copy -f mov dirty.mov
ffmpeg -y -loglevel error -f lavfi -i sine=d=1 -c:a libmp3lame $M -id3v2_version 3 dirty.mp3
ffmpeg -y -loglevel error -f lavfi -i sine=d=1 -c:a libopus $M dirty.ogg
ffmpeg -y -loglevel error -f lavfi -i sine=r=8000:d=0.5 -ac 1 -c:a pcm_s16le $M dirty.wav
ffmpeg -y -loglevel error -f lavfi -i sine=d=1 -c:a aac $M -movflags use_metadata_tags dirty.m4a
ffmpeg -y -loglevel error -f lavfi -i sine=d=1 -c:a aac -f adts dirty.aac
printf "ID3\004\000\000\000\000\000\000" > id3.bin && cat id3.bin dirty.aac > dirty-id3.aac && rm id3.bin
# A clip whose audio stream comes before its video stream
ffmpeg -y -loglevel error -f lavfi -i testsrc=size=64x64:rate=5:duration=1 -f lavfi -i sine=d=1 -map 1:a -map 0:v -c:v libx264 -pix_fmt yuv420p -c:a aac -metadata location=+40.7128-074.0060/ -metadata model=PhoneX -movflags use_metadata_tags dirty-audio-first.mp4
# A clip with nothing to cut
ffmpeg -y -loglevel error -f lavfi -i sine=d=1 -c:a libmp3lame -map_metadata -1 -write_id3v2 0 -write_xing 0 -fflags +bitexact clean.mp3
# An mp3 with a cover picture (a picture has its own EXIF)
ffmpeg -y -loglevel error -f lavfi -i color=c=red:s=32x32:d=1 -frames:v 1 cover.jpg
ffmpeg -y -loglevel error -f lavfi -i sine=d=1 -i cover.jpg -map 0 -map 1 -c:a libmp3lame -c:v copy -id3v2_version 3 -disposition:v attached_pic dirty-cover.mp3
rm cover.jpg
'
