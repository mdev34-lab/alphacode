#!/usr/bin/env bash
# gh stub for release-flow tests: ref/release state only, no network.
# State lives in $GH_STUB_STATE; the "remote" git refs live in $GH_STUB_ORIGIN (a bare repo).
set -euo pipefail
state="${GH_STUB_STATE:?GH_STUB_STATE required}"
mkdir -p "$state/releases"
printf '%s\n' "$*" >> "$state/log"

cmd="${1:-}"
[ $# -ge 1 ] && shift

has_flag() { case " $* " in *" $1 "*) return 0;; *) return 1;; esac; }

if [ "$cmd" = "api" ]; then
  method="GET"
  if [ "${1:-}" = "-X" ]; then method="$2"; shift 2; fi
  endpoint="${1:?endpoint required}"
  tag="${endpoint##*/}"
  origin="${GH_STUB_ORIGIN:?}"
  case "$method" in
    GET)
      case "$endpoint" in
        repos/*/git/ref/tags/*)
          git --git-dir="$origin" rev-parse -q --verify "refs/tags/$tag" >/dev/null || { echo "Not Found" >&2; exit 1; }
          printf '{"ref":"refs/tags/%s"}\n' "$tag"
          ;;
        *) echo "stub: unhandled api call: GET $endpoint" >&2; exit 1 ;;
      esac
      ;;
    DELETE)
      case "$endpoint" in
        repos/*/git/refs/tags/*)
          git --git-dir="$origin" update-ref -d "refs/tags/$tag" || { echo "Not Found" >&2; exit 1; }
          ;;
        *) echo "stub: unhandled api call: DELETE $endpoint" >&2; exit 1 ;;
      esac
      ;;
    *) echo "stub: unhandled api method: $method" >&2; exit 1 ;;
  esac
  exit 0
fi

sub="${1:-}"
[ "$cmd" = "release" ] && [ $# -ge 1 ] && shift

case "$cmd $sub" in
  "release create")
    tag="${1:?tag required}"
    if [ "${GH_STUB_FAIL_CREATE:-}" = "1" ]; then
      echo "stub: forced create failure" >&2
      exit 1
    fi
    if [ -f "$state/releases/$tag.json" ]; then
      echo "a release with the same tag name already exists" >&2
      exit 1
    fi
    id=$(( $(cat "$state/counter" 2>/dev/null || echo 1000) + 1 ))
    echo "$id" > "$state/counter"
    # A draft release creates NO git ref: the tag only appears on publish.
    printf '{"tagName":"%s","databaseId":%s,"isDraft":true}\n' "$tag" "$id" > "$state/releases/$tag.json"
    echo "https://stub.invalid/releases/$tag"
    ;;
  "release view")
    tag="${1:?tag required}"
    [ -f "$state/releases/$tag.json" ] || { echo "release not found" >&2; exit 1; }
    cat "$state/releases/$tag.json"
    ;;
  "release edit")
    tag="${1:?tag required}"
    [ -f "$state/releases/$tag.json" ] || { echo "release not found" >&2; exit 1; }
    if has_flag "--draft=false" "$@"; then
      sed -i 's/"isDraft":true/"isDraft":false/' "$state/releases/$tag.json"
    fi
    ;;
  "release delete")
    tag="${1:?tag required}"
    [ -f "$state/releases/$tag.json" ] || { echo "release not found" >&2; exit 1; }
    rm -f "$state/releases/$tag.json"
    if has_flag "--cleanup-tag" "$@"; then
      git --git-dir="${GH_STUB_ORIGIN:?}" update-ref -d "refs/tags/$tag" || true
    fi
    ;;
  "release upload")
    tag="${1:?tag required}"
    shift
    [ -f "$state/releases/$tag.json" ] || { echo "release not found" >&2; exit 1; }
    while [ $# -gt 0 ]; do
      case "$1" in
        --repo) shift 2 ;;
        --*) shift ;;
        *) [ -f "$1" ] || { echo "stub: upload asset missing: $1" >&2; exit 1; }
           printf '%s\n' "$1" >> "$state/uploads"
           shift ;;
      esac
    done
    ;;
  *)
    echo "stub: unhandled command: $cmd $sub $*" >&2
    exit 1
    ;;
esac
