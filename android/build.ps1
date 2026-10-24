# Builds dist/PhoneShare.apk with the plain SDK tools (aapt2, javac, d8, zipalign, apksigner); no Gradle.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = Split-Path -Parent $here
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $root '.tools\android-sdk' }
$bt = Join-Path $sdk 'build-tools\36.1.0'
$jar = Join-Path $sdk 'platforms\android-36\android.jar'
$jdk = if ($env:JAVA_HOME -and (Test-Path "$env:JAVA_HOME\bin\javac.exe")) { $env:JAVA_HOME } else { 'W:\jdk' }
$env:JAVA_HOME = $jdk
$env:PATH = "$jdk\bin;$env:PATH"   # d8 and apksigner need Java 11+

function Run($exe) {
    & $exe @args
    if ($LASTEXITCODE -ne 0) { throw "$(Split-Path -Leaf $exe) failed with exit code $LASTEXITCODE" }
}

# VERSION is the one version of the whole project; x.y.z gives versionCode x*10000 + y*100 + z, which the updater compares
$version = (Get-Content (Join-Path $root 'VERSION') -Raw).Trim()
$v = [version]$version
$code = $v.Major * 10000 + $v.Minor * 100 + $v.Build

$b = Join-Path $here 'build'
if (Test-Path $b) { Remove-Item -Recurse -Force $b }
New-Item -ItemType Directory -Force "$b\gen", "$b\classes", "$b\dex" | Out-Null

Run "$bt\aapt2.exe" compile --dir "$here\res" -o "$b\res.zip"
Run "$bt\aapt2.exe" link -I $jar --manifest "$here\AndroidManifest.xml" --java "$b\gen" `
    --min-sdk-version 29 --target-sdk-version 36 --version-code $code --version-name $version -o "$b\app.unsigned.apk" "$b\res.zip"

$src = @(Get-ChildItem -Recurse "$here\src", "$b\gen" -Filter *.java | ForEach-Object FullName)
Run "$jdk\bin\javac.exe" -encoding UTF-8 -source 8 -target 8 -bootclasspath "$jar;$bt\core-lambda-stubs.jar" '-Xlint:-options' -d "$b\classes" @src
$classes = @(Get-ChildItem -Recurse "$b\classes" -Filter *.class | ForEach-Object FullName)
Run "$bt\d8.bat" --release --min-api 29 --lib $jar --output "$b\dex" @classes

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open("$b\app.unsigned.apk", 'Update')
[void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, "$b\dex\classes.dex", 'classes.dex')
# web/ goes in by hand: aapt2 -A on Windows names entries "assets/web\app.js", which Android cannot open
foreach ($f in Get-ChildItem "$root\web" -File) {
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, "assets/web/$($f.Name)")
}
$zip.Dispose()

Run "$bt\zipalign.exe" -p -f 4 "$b\app.unsigned.apk" "$b\app.aligned.apk"

# The signing key lives outside the repo (PHONESHARE_KEYS, default W:\Keys\PhoneShare). Updates install only over an APK
# signed with the same key, so it is created once and must never be lost.
$keys = if ($env:PHONESHARE_KEYS) { $env:PHONESHARE_KEYS } else { 'W:\Keys\PhoneShare' }
$ks = Join-Path $keys 'android.keystore'
if (-not (Test-Path $ks)) {
    New-Item -ItemType Directory -Force $keys | Out-Null
    Run "$jdk\bin\keytool.exe" -genkeypair -keystore $ks -storepass android -keypass android -alias phoneshare `
        -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=PhoneShare"
}
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
Run "$bt\apksigner.bat" sign --ks $ks --ks-pass pass:android --key-pass pass:android --ks-key-alias phoneshare `
    --out "$dist\PhoneShare.apk" "$b\app.aligned.apk"
Remove-Item "$dist\PhoneShare.apk.idsig" -ErrorAction SilentlyContinue   # v4 signature for adb streaming installs, not needed
Write-Output "APK: $dist\PhoneShare.apk ($version, code $code)"
