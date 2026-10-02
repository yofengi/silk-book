!macro NSIS_HOOK_PREUNINSTALL
  ; Let the installed executable remove only registrations owned by this installation.
  ; This keeps registry ownership logic in Rust; the raw cleanup below is a fallback
  ; for damaged or partially removed installations.
  ${If} ${FileExists} "$INSTDIR\boshu.exe"
    ClearErrors
    ExecWait '"$INSTDIR\boshu.exe" --unregister-assoc all' $R5
    ${If} ${Errors}
      StrCpy $R5 1
    ${EndIf}
    ${If} $R5 == 0
      Goto boshu_assoc_done
    ${EndIf}
  ${EndIf}

  ReadRegStr $R0 HKCU "Software\RegisteredApplications" "Boshu"
  StrCmp $R0 "Software\Boshu\Capabilities" 0 boshu_assoc_done
  ReadRegStr $R0 HKCU "Software\Classes\Applications\boshu.exe\shell\open\command" ""
  StrCmp $R0 '"$INSTDIR\boshu.exe" "%1"' 0 boshu_assoc_done
  StrCpy $R1 0
  boshu_assoc_loop:
    EnumRegValue $R2 HKCU "Software\Boshu\Capabilities\FileAssociations" $R1
    StrCmp $R2 "" boshu_assoc_finish
    ReadRegStr $R3 HKCU "Software\Boshu\Capabilities\FileAssociations" $R2
    ReadRegStr $R4 HKCU "Software\Classes\$R3\shell\open\command" ""
    StrCmp $R4 '"$INSTDIR\boshu.exe" "%1"' 0 boshu_assoc_next
    DeleteRegKey HKCU "Software\Classes\$R3"
    DeleteRegValue HKCU "Software\Classes\$R2\OpenWithProgids" "$R3"
    DeleteRegValue HKCU "Software\Classes\Applications\boshu.exe\SupportedTypes" "$R2"
    boshu_assoc_next:
    IntOp $R1 $R1 + 1
    Goto boshu_assoc_loop
  boshu_assoc_finish:
    ; Older builds used shared ProgIDs that may not be listed in Capabilities.
    ; Remove them only when their open command still belongs to this install.
    ReadRegStr $R6 HKCU "Software\Classes\Boshu.File\shell\open\command" ""
    StrCmp $R6 '"$INSTDIR\boshu.exe" "%1"' 0 boshu_legacy_code
    DeleteRegKey HKCU "Software\Classes\Boshu.File"
    StrCpy $R1 0
    boshu_legacy_file_types:
      EnumRegValue $R2 HKCU "Software\Classes\Applications\boshu.exe\SupportedTypes" $R1
      StrCmp $R2 "" boshu_legacy_code
      DeleteRegValue HKCU "Software\Classes\$R2\OpenWithProgids" "Boshu.File"
      IntOp $R1 $R1 + 1
      Goto boshu_legacy_file_types
    boshu_legacy_code:
    ReadRegStr $R6 HKCU "Software\Classes\Boshu.Code\shell\open\command" ""
    StrCmp $R6 '"$INSTDIR\boshu.exe" "%1"' 0 boshu_legacy_text
    DeleteRegKey HKCU "Software\Classes\Boshu.Code"
    StrCpy $R1 0
    boshu_legacy_code_types:
      EnumRegValue $R2 HKCU "Software\Classes\Applications\boshu.exe\SupportedTypes" $R1
      StrCmp $R2 "" boshu_legacy_text
      DeleteRegValue HKCU "Software\Classes\$R2\OpenWithProgids" "Boshu.Code"
      IntOp $R1 $R1 + 1
      Goto boshu_legacy_code_types
    boshu_legacy_text:
    ReadRegStr $R6 HKCU "Software\Classes\Boshu.Text\shell\open\command" ""
    StrCmp $R6 '"$INSTDIR\boshu.exe" "%1"' 0 boshu_assoc_cleanup
    DeleteRegKey HKCU "Software\Classes\Boshu.Text"
    StrCpy $R1 0
    boshu_legacy_text_types:
      EnumRegValue $R2 HKCU "Software\Classes\Applications\boshu.exe\SupportedTypes" $R1
      StrCmp $R2 "" boshu_assoc_cleanup
      DeleteRegValue HKCU "Software\Classes\$R2\OpenWithProgids" "Boshu.Text"
      IntOp $R1 $R1 + 1
      Goto boshu_legacy_text_types
    boshu_assoc_cleanup:
    DeleteRegKey HKCU "Software\Classes\Applications\boshu.exe"
    DeleteRegKey HKCU "Software\Boshu\Capabilities"
    DeleteRegValue HKCU "Software\RegisteredApplications" "Boshu"
  boshu_assoc_done:
!macroend
