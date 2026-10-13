# Halo

אפליקציית iPhone לנתב Xiaomi BE6500 Pro.

- `web/` - הממשק (HTML/JS). נפתח גם בדפדפן רגיל, במצב הדגמה.
- `Halo/` - מעטפת iOS (SwiftUI + WKWebView) שמתחברת לנתב בכתובת 192.168.31.1. הסיסמה נשמרת ב-Keychain של הטלפון בלבד.
- כל push ל-`main` בונה IPA לא חתום ב-GitHub Actions ומפרסם אותו ב-Release בשם `latest`, להתקנה דרך Sideloadly.
