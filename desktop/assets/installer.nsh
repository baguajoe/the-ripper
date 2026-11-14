; The Ripper - NSIS hooks (electron-builder `nsis.include`).
;
; Uninstall must not leave the user's library behind: a later reinstall would bring old
; tracks back. On a real uninstall (not when an update/reinstall replaces the app, which
; runs the old uninstaller with --updated) we stop the engine and delete:
;   %APPDATA%\TheRipper     engine data: track library (storage\), engine.json, numba cache,
;                           engine-crash.log
;   %APPDATA%\The Ripper    app data: settings, logs, Chromium cache
; Exported files (Downloads, your export folder) are never touched.

!macro customUnInstall
  ; The engine (and its job workers) run from $INSTDIR and keep files open - stop them first.
  nsExec::Exec 'taskkill /F /T /IM ripper-engine.exe'
  Pop $0
  ${ifNot} ${isUpdated}
    ; electron-builder may have switched to "all users" context; app data is per user.
    SetShellVarContext current
    RMDir /r "$APPDATA\TheRipper"
    RMDir /r "$APPDATA\The Ripper"
  ${endIf}
!macroend
