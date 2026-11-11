; 自定义「安装前关闭旧版」逻辑（覆盖 electron-builder 默认的 _CHECK_APP_RUNNING）。
;
; 为什么必须覆盖（2026-11-11 真机事故）：
; 默认宏在升级安装时按「进程 exe 路径以 $INSTDIR 开头」判断旧版是否还在跑，
; 杀不掉就循环，第 2 轮之后固定弹「FinalCheck 无法关闭，请手动关闭后重试」，
; 而当时进程列表里根本没有 FinalCheck.exe（用户 tasklist 已确认），
; 结果安装器把自己锁死，用户只能取消。
;
; 这里的原则：安装器永远不阻塞用户。
;   1) 按精确镜像名强制结束旧版（含子进程），两条命令给自动更新/托盘退出留时间；
;   2) 无论杀没杀掉都继续装；真被文件占用时由 NSIS 自己报错，不再死循环。
!macro customCheckAppRunning
  DetailPrint "Closing running FinalCheck instances"
  nsExec::Exec `"$SYSDIR\taskkill.exe" /F /IM FinalCheck.exe /T`
  Pop $0
  Sleep 500
  nsExec::Exec `"$SYSDIR\taskkill.exe" /F /IM FinalCheck.exe /T`
  Pop $0
  Sleep 300
!macroend
