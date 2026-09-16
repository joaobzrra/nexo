!macro customInstall
  ; Give each release a new icon path. Windows caches icons by path and can
  ; otherwise keep the previous artwork after an in-place Nexo update.
  CopyFiles /SILENT "$INSTDIR\resources\brand\nexo.ico" "$INSTDIR\resources\brand\nexo-${VERSION}.ico"

  WriteRegStr HKCU "Software\Classes\Directory\shell\Nexo" "" "Open in Nexo"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Nexo" "Icon" "$\"$INSTDIR\resources\brand\nexo-${VERSION}.ico$\",0"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Nexo\command" "" '"$INSTDIR\Nexo.exe" --open="%1"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Nexo" "" "Open in Nexo"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Nexo" "Icon" "$\"$INSTDIR\resources\brand\nexo-${VERSION}.ico$\",0"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Nexo\command" "" '"$INSTDIR\Nexo.exe" --open="%V"'

  ; electron-builder created the Start Menu link immediately before this
  ; macro. Recreate it with the versioned icon and preserve its app identity.
  Delete "$newStartMenuLink"
  CreateShortCut "$newStartMenuLink" "$appExe" "" "$INSTDIR\resources\brand\nexo-${VERSION}.ico" 0 "" "" "${APP_DESCRIPTION}"
  WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"

  ; Refresh Explorer context menus and Start Search after registry/shortcut
  ; changes. SHCNF_FLUSH makes the update synchronous for this installation.
  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0x1000, 0, 0)'
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION "Keep Nexo's normalized local telemetry data for a future reinstall or export?$\r$\n$\r$\nChoose No to remove all Nexo telemetry data. Your Codex and Claude sessions are never deleted." IDYES keepTelemetry
      ExecWait '"$INSTDIR\Nexo.exe" --uninstall-cleanup=delete'
      Goto telemetryChoiceDone
    keepTelemetry:
      ExecWait '"$INSTDIR\Nexo.exe" --uninstall-cleanup=keep'
    telemetryChoiceDone:
    DeleteRegKey HKCU "Software\Classes\Directory\shell\Nexo"
    DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Nexo"
  ${endIf}
!macroend
