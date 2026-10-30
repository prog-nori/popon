"""Install the YouTube adapter in a repository-local Python virtual environment."""
from pathlib import Path
import os
import shutil
import subprocess
import sys

# macOS may resolve python3 to Apple's 3.9; use an installed supported Python.
if sys.version_info < (3, 10):
    for name in ["python3.14", "python3.13", "python3.12", "python3.11", "python3.10", "/usr/local/bin/python3", "/opt/homebrew/bin/python3"]:
        candidate = shutil.which(name)
        if candidate and subprocess.run([candidate, "-c", "import sys; sys.exit(sys.version_info < (3,10))"], capture_output=True).returncode == 0:
            sys.exit(subprocess.call([candidate, __file__]))
    sys.exit("Python 3.10以上を導入し、npm run setup:media を再実行してください。")

root = Path(__file__).resolve().parent.parent
environment = root / ".tools" / "media"
subprocess.run([sys.executable, "-m", "venv", "--clear", str(environment)], check=True)
python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
subprocess.run(
    [str(python), "-m", "pip", "install", "--upgrade", "--no-cache-dir", "yt-dlp[default]>=2025.11.12"],
    check=True,
)
subprocess.run([str(python), "-m", "yt_dlp", "--version"], check=True)
print("yt-dlpの準備ができました。Botを再起動してください。ffmpegは別途PATHに必要です。")
