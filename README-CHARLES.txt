NINI DAILY - ICON UPDATE (for Build 5)

1. On GitHub (charlesfamily/NiNi): Add file -> Upload files.
2. Drag in the whole "ios" folder from this package. Commit changes.
   It replaces ONE file: the app icon, deep inside Assets.xcassets.
3. Codemagic -> Start new build -> iOS Release (TestFlight) -> branch main.
4. TestFlight on the iPad -> Update. New icon shows on the app and home screen.

The stray top-level files from last time are still harmless - ignore them.
