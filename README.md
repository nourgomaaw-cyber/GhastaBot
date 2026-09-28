  # Arabic Voice Chatbot

  A simple Arabic chatbot for Termux.
  Type messages or speak using your
  microphone. With Termux:API installed,
  it can read its replies aloud.

  ## Requirements

  - Termux
  - Python
  - Termux:API for voice input and speech

  ## Setup

  In Termux, install the required
  packages:

  ```sh
  pkg install python termux-api

  Install the Termux:API Android app,
  allow microphone access, then run:

  cd ~/storage/downloads
  python arabic_voice_bot.py

  Type or say خروج to quit.
