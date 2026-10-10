# 本项目为 WebView 混合应用，未使用反射，默认规则即可
-keepattributes *Annotation*
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
