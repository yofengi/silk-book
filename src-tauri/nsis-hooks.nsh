!macro NSIS_HOOK_POSTINSTALL
  ; Restore only previously chosen types. A silent first install has no saved
  ; choices and registers nothing. Commands always target the final executable.
  ClearErrors
  ExecWait '"$INSTDIR\boshu.exe" --restore-assoc' $R5
  ${If} ${Errors}
    StrCpy $R5 1
  ${EndIf}
  ${If} $R5 <> 0
    DetailPrint "Could not restore file associations; retry in Boshu settings."
    ${IfNot} ${Silent}
    ${AndIf} $PassiveMode <> 1
      MessageBox MB_ICONEXCLAMATION|MB_OK "文件关联恢复失败。可在帛书设置中重新注册；原选择仍会保留。"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; This hook runs after CheckIfAppIsRunning succeeds. Missing/broken binaries
  ; must be repaired first; raw registry deletion could lose the only selection
  ; snapshot, or claim that Delete app data succeeded while retaining settings.
  ${IfNot} ${FileExists} "$INSTDIR\boshu.exe"
    MessageBox MB_ICONEXCLAMATION|MB_OK "程序文件缺失，无法安全维护文件关联与用户数据。请先重新安装帛书，再卸载。" /SD IDOK
    SetErrorLevel 1
    Quit
  ${EndIf}

  ClearErrors
  ExecWait '"$INSTDIR\boshu.exe" --cleanup-assoc' $R5
  ${If} ${Errors}
    StrCpy $R5 1
  ${EndIf}
  ${If} $R5 <> 0
    ; Repair any partially removed registration before aborting the uninstall.
    ExecWait '"$INSTDIR\boshu.exe" --restore-assoc' $R5
    MessageBox MB_ICONEXCLAMATION|MB_OK "无法保存文件关联选择，卸载已取消。请检查用户数据目录权限后重试。" /SD IDOK
    SetErrorLevel 1
    Quit
  ${EndIf}

  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; Delete only the fixed app data directory using Rust's non-following
    ; removal; the maintenance command accepts no caller-supplied path.
    ClearErrors
    ExecWait '"$INSTDIR\boshu.exe" --delete-assoc-data' $R5
    ${If} ${Errors}
      StrCpy $R5 1
    ${EndIf}
    ${If} $R5 <> 0
      MessageBox MB_ICONEXCLAMATION|MB_OK "用户数据删除失败，请检查目录权限后重试。" /SD IDOK
      SetErrorLevel 1
      Quit
    ${EndIf}
  ${EndIf}
!macroend
