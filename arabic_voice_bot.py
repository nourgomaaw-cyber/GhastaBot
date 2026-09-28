#!/usr/bin/env python3
"""A small Arabic voice chatbot for Termux (Termux:API recommended)."""

import random
import shutil
import subprocess
import sys
from datetime import datetime


BOT_NAME = "رفيق"


def has_command(name):
    return shutil.which(name) is not None


def speak(message):
    """Speak through Termux:API when available; always show the reply."""
    print(f"\n{BOT_NAME}: {message}")
    if has_command("termux-tts-speak"):
        try:
            subprocess.run(
                ["termux-tts-speak", "-l", "ar", message],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=30,
            )
        except (OSError, subprocess.TimeoutExpired):
            print("(لم أستطع تشغيل الصوت. تأكد من تثبيت Termux:API.)")


def listen():
    """Use Android speech recognition, or fall back to keyboard input."""
    if has_command("termux-speech-to-text"):
        print("🎙️ اتكلم الآن...")
        try:
            result = subprocess.run(
                ["termux-speech-to-text"],
                capture_output=True,
                text=True,
                timeout=45,
                check=False,
            )
            phrase = result.stdout.strip()
            if phrase:
                print(f"أنت: {phrase}")
                return phrase
            print("لم أسمع كلامًا واضحًا، جرّب الكتابة.")
        except (OSError, subprocess.TimeoutExpired):
            print("تعذّر فتح الميكروفون، جرّب الكتابة.")

    try:
        return input("أنت: ").strip()
    except (EOFError, KeyboardInterrupt):
        return "خروج"


def reply(message, memory):
    text = message.strip().lower()

    if any(word in text for word in ("اسمك", "اسمك ايه", "اسمك إيه")):
        return f"أنا {BOT_NAME}، صاحبك الصوتي الصغير!"
    if any(word in text for word in ("عامل ايه", "عامل إيه", "اخبارك", "أخبارك", "كيف حالك")):
        return random.choice(("أنا تمام وجاهز أرغي معاك! وإنت عامل إيه؟", "زي الفل! احكيلي أخبارك."))
    if any(word in text for word in ("الوقت", "الساعة كام", "الساعة")):
        return "الساعة الآن " + datetime.now().strftime("%I:%M %p")
    if any(word in text for word in ("شكرا", "شكراً", "تسلم", "حبيبي")):
        return random.choice(("العفو يا نجم!", "حبيبي، أنا موجود دايمًا."))
    if any(word in text for word in ("نكتة", "اضحكني", "ضحكني")):
        return random.choice((
            "مرة كمبيوتر راح للدكتور، قاله: عندي فيروس!",
            "مرة واحد بخيل فتح محل عصير، كتب: اشرب هنا أو اشرب في بيتكم!",
            "مرة قلم رصاص اتخانق مع ممحاة، قالها: امسحي اللي فات!",
        ))
    if any(word in text for word in ("خروج", "اقفل", "إغلاق", "باي", "سلام")):
        return "انبسطت بالكلام معاك! أشوفك قريب يا بطل."

    memory.append(message)
    if len(memory) > 8:
        memory.pop(0)
    prompts = (
        "احكيلي أكتر عن الموضوع ده.",
        "فهمت عليك. وإيه أكتر حاجة عجبتك أو ضايقتك فيه؟",
        "دي نقطة interesting! كمّل، أنا سامعك.",
        "طب لو تقدر تغيّر حاجة واحدة في الموضوع، هتغيّر إيه؟",
        "أنا معاك. تحب نتكلم عن ده أكتر ولا نغيّر الموضوع؟",
    )
    return random.choice(prompts)


def main():
    speak("أهلًا يا بطل! أنا رفيق. تقدر تتكلم أو تكتب، وقول خروج لما تحب نقفل.")
    if not has_command("termux-tts-speak"):
        print("ملاحظة: لتشغيل الردود بالصوت، ثبّت تطبيق Termux:API وحزمة termux-api.")
    if not has_command("termux-speech-to-text"):
        print("ملاحظة: للإجابة بالصوت، ثبّت Termux:API واسمح له باستخدام الميكروفون.")

    memory = []
    while True:
        message = listen()
        if not message:
            continue
        answer = reply(message, memory)
        speak(answer)
        if any(word in message.lower() for word in ("خروج", "اقفل", "إغلاق", "باي", "سلام")):
            break


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nمع السلامة!")
        sys.exit(0)
