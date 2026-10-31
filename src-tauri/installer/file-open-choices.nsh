; 仅注册打开方式，不接管已有默认应用。
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHELL_CONTEXT "Software\Classes\com.mora.desktop.mdx" "" "Mora MDXNote"
  WriteRegStr SHELL_CONTEXT "Software\Classes\com.mora.desktop.mdx\DefaultIcon" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0'
  WriteRegStr SHELL_CONTEXT "Software\Classes\com.mora.desktop.mdx\shell\open\command" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"'
  WriteRegStr SHELL_CONTEXT "Software\Classes\com.mora.desktop.markdown" "" "Mora Markdown"
  WriteRegStr SHELL_CONTEXT "Software\Classes\com.mora.desktop.markdown\DefaultIcon" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0'
  WriteRegStr SHELL_CONTEXT "Software\Classes\com.mora.desktop.markdown\shell\open\command" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"'
  WriteRegStr SHELL_CONTEXT "Software\Classes\.mdx\OpenWithProgids" "com.mora.desktop.mdx" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\.md\OpenWithProgids" "com.mora.desktop.markdown" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\.markdown\OpenWithProgids" "com.mora.desktop.markdown" ""
  !insertmacro UPDATEFILEASSOC
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.mdx\OpenWithProgids" "com.mora.desktop.mdx"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.md\OpenWithProgids" "com.mora.desktop.markdown"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.markdown\OpenWithProgids" "com.mora.desktop.markdown"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\com.mora.desktop.mdx"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\com.mora.desktop.markdown"
  !insertmacro UPDATEFILEASSOC
!macroend
