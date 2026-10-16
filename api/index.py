import os
import sys
from pathlib import Path

# Add project root to sys.path so video_web_app can be imported
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from video_web_app import app

# Vercel entrypoint exports 'app'
