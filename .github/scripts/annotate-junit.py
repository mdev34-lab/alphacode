import os
import sys
import xml.etree.ElementTree as ET


def escape_command_property(value: str) -> str:
    return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def log_lines(log_path: str) -> list[str]:
    if not os.path.exists(log_path):
        return []

    with open(log_path, encoding="utf-8", errors="replace") as log:
        return log.read().splitlines()


def failure_excerpt(lines: list[str], name: str, path: str) -> str:
    markers = [index for index, line in enumerate(lines) if name in line]
    if not markers:
        file_name = os.path.basename(path)
        markers = [index for index, line in enumerate(lines) if file_name and file_name in line]
    if not markers:
        return ""

    end = markers[-1]
    return chr(10).join(lines[max(0, end - 20) : min(len(lines), end + 4)])


def annotate(title: str, message: str, path: str = "") -> None:
    message = escape_command_property(message[:3000])
    if path:
        print(f"::error file={escape_command_property(path)},title={escape_command_property(title)}::{message}")
    else:
        print(f"::error title={escape_command_property(title)}::{message}")


def main() -> int:
    if len(sys.argv) != 6:
        print("usage: annotate-junit.py REPORT PACKAGE_ROOT TITLE LOG_PATH EXIT_STATUS", file=sys.stderr)
        return 2

    report, package_root, title, log_path, raw_status = sys.argv[1:]
    status = int(raw_status)
    lines = log_lines(log_path)
    if not os.path.exists(report):
        print(f"::warning::Bun did not produce the JUnit report: {report}")
        if status:
            annotate(f"{title} test command failed without JUnit", chr(10).join(lines[-80:]))
        return 0

    repo = os.path.abspath(os.environ.get("GITHUB_WORKSPACE", os.getcwd()))
    root = ET.parse(report).getroot()
    failures = 0
    for case in root.iter("testcase"):
        failure = case.find("failure")
        if failure is None:
            failure = case.find("error")
        if failure is None:
            continue
        failures += 1

        path = case.get("file", "")
        if os.path.isabs(path):
            path = os.path.relpath(path, repo)
        path = path.replace("\\", "/")
        if not path.startswith("packages/"):
            path = f"{package_root}/{path}"

        line = case.get("line", "1")
        name = case.get("name", "unknown test")
        detail = " ".join(((failure.get("message") or "") + " " + (failure.text or "")).split())
        excerpt = failure_excerpt(lines, name, path)
        annotate(title, f"{name}: {detail}{chr(10)}{excerpt}", f"{path},line={line}")

    if status and not failures:
        annotate(f"{title} test command failed without a JUnit failure", chr(10).join(lines[-80:]))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
