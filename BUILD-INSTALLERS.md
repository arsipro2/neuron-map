# Сборка установщиков Neuron Map 0.22.2

Проект содержит готовые сценарии сборки; сам архив исходников не является установщиком.

| Система | Результат | Где собирать |
| --- | --- | --- |
| Ubuntu, x64 по умолчанию | `.deb` и `.AppImage` | Ubuntu или Linux-контейнер Docker |
| Windows, x64 по умолчанию | `.exe` NSIS; дополнительно `.msi` | Windows или Windows runner в GitHub Actions |
| macOS | `.dmg` с `.app` | Mac или macOS runner в GitHub Actions |
| macOS Intel + Apple Silicon | один Universal `.dmg` с `.app` | Mac с двумя Rust targets; готовый CI использует этот вариант |

## 1. Обычный запуск без localhost

После установки открывайте **Neuron Map** из меню приложений / Start / Applications.
Node.js, npm, Rust, Docker и запущенный терминал конечному пользователю не нужны.
Tauri встраивает `dist` в исполняемый файл через `build.frontendDist`; `tauri build` включает production custom protocol.
Приложение читает заметки из локальной SQLite и не запускает HTTP-сервер.
PDF, шрифты и Worker также входят в сборку.

`npm run desktop` — режим **разработки**, в котором Vite слушает `127.0.0.1:5173`.
Для обычного использования соберите установщик одним из способов ниже.
Слова `tauri.localhost` / `ipc.localhost` во внутренних адресах WebView обозначают протокол Tauri; это не отдельный слушающий сервер.
Удалять `devUrl` из конфигурации не требуется.

Сборка впервые требует интернета для npm, Cargo и инструментов упаковки. Установка `.deb` может потребовать сеть для системных библиотек; обычный Windows EXE скачивает WebView2, если его нет. Это отличается от работы уже установленного приложения, которому сервер не нужен.

## 2. Ubuntu: локальная сборка

Базовая цель — Ubuntu **22.04 и новее** с актуальными обновлениями WebKitGTK и работающим WebGL 2. Реальная совместимость установщиков ещё требует проверки на этих системах. Сборка на более новой Ubuntu может зависеть от более новой glibc; для общего дистрибутива используйте Docker с базой 22.04.

Установите [Node.js 24 LTS](https://nodejs.org/en/download) и [Rust через rustup](https://rustup.rs/), затем зависимости Tauri:

```bash
sudo apt update
sudo apt install -y build-essential curl wget file pkg-config \
  libgtk-3-dev libwebkit2gtk-4.1-dev libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf squashfs-tools
rustup update stable
```

В корне распакованного проекта:

```bash
npm ci
npm run build:linux
```

Результаты:

- `src-tauri/target/release/bundle/deb/*.deb`
- `src-tauri/target/release/bundle/appimage/*.AppImage`

Установка DEB:

```bash
sudo apt install ./src-tauri/target/release/bundle/deb/*.deb
```

После этого откройте Neuron Map из меню Ubuntu. Для AppImage сначала разрешите исполнение файла (`chmod +x путь/к/файлу.AppImage`), затем запустите его. Если на системе нет FUSE, используйте режим `--appimage-extract-and-run`; детали — в [документации AppImage](https://docs.appimage.org/user-guide/troubleshooting/fuse.html).

Можно собирать один формат:

```bash
npm run build:linux:deb
npm run build:linux:appimage
```

Для ARM Linux собирайте на ARM Linux или в подходящем эмуляторе. Готовый workflow ниже собирает Linux x64; AppImage нельзя получить простым добавлением чужого Rust target.

## 3. Ubuntu: сборка в Docker

Нужен Docker с Buildx. Node.js, Rust и SDK на компьютере для этого способа не требуются. Команду запускайте из корня проекта:

```bash
docker buildx build --platform linux/amd64 --target artifacts \
  --progress=plain --output type=local,dest=./release/ubuntu-x64 .
```

В `release/ubuntu-x64` появятся `.deb`, `.AppImage` и `SHA256SUMS`. Проверка контрольных сумм:

```bash
cd release/ubuntu-x64
sha256sum -c SHA256SUMS
```

`Dockerfile` использует Ubuntu 22.04, Node 24, Rust stable, `npm ci` и Cargo `--locked`. Кэши Cargo ускоряют повторные сборки; Docker не получает базу с заметками. Для самой упаковки AppImage включён режим без FUSE, поэтому `--privileged` и `/dev/fuse` не требуются. Версии npm/Cargo-зависимостей зафиксированы lock-файлами; базовые образы, системные обновления и Rust stable со временем обновляются, поэтому побайтовая воспроизводимость не обещается.

Docker здесь **собирает Linux-установщики**. Графическое приложение затем работает в обычной системе. Перенос GUI в контейнер потребовал бы доступа к дисплею и GPU и не добавил бы преимуществ обычному запуску. Порты публиковать не нужно.

Один Linux-контейнер не заменяет все три системы сборки. Кросс-компиляция Windows NSIS возможна с дополнительными инструментами, но для этого проекта выбран native Windows runner. DMG собирается на macOS. На Mac/Windows можно собрать Linux-пакеты через Docker Desktop; `linux/amd64` на ARM-хосте потребует эмуляции и будет медленнее.

## 4. Windows

На Windows установите:

1. Node.js 24 LTS.
2. [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) с **Desktop development with C++** и Windows SDK.
3. [Rust](https://rustup.rs/) с MSVC toolchain. Для обычного x64 ПК используйте `stable-x86_64-pc-windows-msvc`.

Откройте новый PowerShell в корне проекта:

```powershell
npm ci
npm run build:windows
```

EXE будет в `src-tauri\target\release\bundle\nsis\`. Установщик предлагает русский и английский языки; само приложение пока использует прежние английские подписи. Программа устанавливается для текущего пользователя. В release-версии не открывается лишнее окно консоли.

Если WebView2 отсутствует, обычный установщик скачает его. Для установки без интернета:

```powershell
npm run build:windows:offline
```

Этот EXE включает установщик WebView2 и получается существенно больше. Интернет всё равно нужен на машине **сборки**. Оба варианта записываются в один каталог и могут иметь одинаковое имя — скопируйте первый EXE отдельно, если нужны оба.

При необходимости MSI:

```powershell
npm run build:windows:msi
```

Результат — `src-tauri\target\release\bundle\msi\`. MSI требует системный компонент VBScript; при ошибке `light.exe` проверьте его по [инструкции Tauri](https://v2.tauri.app/distribute/windows-installer/). NSIS используется по умолчанию, поэтому обычная сборка не зависит от WiX/MSI.

Сертификат подписи Windows пока не настроен: при распространении система может показывать неизвестного издателя или предупреждение SmartScreen. Перед публичным выпуском подключите свою [подпись Windows](https://v2.tauri.app/distribute/sign/windows/).

## 5. macOS

Для приложения выбрана минимальная macOS **13.0**, чтобы не заявлять поддержку старых WebKit без проверки. Нужны Node.js 24 LTS, Rust и инструменты Xcode. Для desktop достаточно Command Line Tools:

```bash
xcode-select --install
```

После их установки, в корне проекта:

```bash
npm ci
npm run build:macos
```

Это сборка для архитектуры вашего Mac. `.app` появится в `src-tauri/target/release/bundle/macos/`, `.dmg` — в `src-tauri/target/release/bundle/dmg/`.

Один установщик для Intel и Apple Silicon:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run build:macos:universal
```

В этом случае путь — `src-tauri/target/universal-apple-darwin/release/bundle/`. Откройте DMG и перенесите Neuron Map в Applications.

Пока настроена **ad-hoc подпись** (`signingIdentity: "-"`), пригодная для своей тестовой сборки. Она не заменяет Developer ID и notarization: скачанный файл может потребовать разрешения в Privacy & Security. Для распространения другим пользователям настройте [подпись и notarization macOS](https://v2.tauri.app/distribute/sign/macos/) своим сертификатом. Никаких сертификатов или секретов в архиве нет. При настройке настоящей подписи замените `signingIdentity` или задайте `APPLE_SIGNING_IDENTITY`.

## 6. Все три системы через GitHub Actions

В проект добавлен `.github/workflows/build-installers.yml`. Ручной запуск сохраняет установщики в Actions Artifacts. Отправка тега `v0.22.2` запускает сборку и публикует GitHub Release после успешного завершения всех трёх платформ.

1. Поместите содержимое папки `neuron-map` в **корень** своего GitHub-репозитория, включая папку `.github`. `package.json` должен находиться рядом с ней.
2. Добавьте эти файлы в основную ветку репозитория.
3. Откройте **Actions → Build installers → Run workflow**.
4. При необходимости отметьте `windows_offline`.
5. После завершения скачайте `neuron-map-ubuntu-x64`, `neuron-map-windows-x64`, `neuron-map-macos-universal` из **Artifacts** выбранного запуска.

Ubuntu 22.04 создаёт DEB/AppImage, Windows 2025 — NSIS EXE, macOS 15 — Universal DMG. Узлы выполняются независимо. При ошибке одного можно изучить его журнал и повторить нужную сборку. Внутри ZIP артефакта найдите папку `bundle`. DMG содержит `.app`; отдельно загружать необработанную папку `.app` не нужно, чтобы не потерять права файлов.

Задачи сборки имеют доступ только на чтение. Отдельная задача **Publish release** получает `contents: write`, проверяет наличие DEB, AppImage, EXE и DMG нужной версии, рассчитывает SHA-256 и публикует файлы с описанием из `releases/v0.22.2.md`. Для выпуска по тегу Windows всегда собирается со встроенным автономным установщиком WebView2. Если одна платформа не собралась, релиз не публикуется. Ручной запуск по-прежнему не публикует релиз.

После применения обновления и проверки изменений в своём репозитории:

```bash
cd ~/neuron-map
npm run test:unit
npm run build
git diff --check
git status --short
git add .github/workflows/build-installers.yml README.md BUILD-INSTALLERS.md \
  package.json package-lock.json src src-tauri/Cargo.toml src-tauri/Cargo.lock \
  src-tauri/src src-tauri/tauri.conf.json storage-tests/Cargo.toml \
  storage-tests/Cargo.lock storage-tests/src scripts/prepare-release.mjs \
  tests/core.test.ts tests/attachment-open.spec.ts tests/release.test.mjs releases/v0.22.2.md
git commit -m "feat: open attachments in default apps and release v0.22.2"
git tag -a v0.22.2 -m "Neuron Map 0.22.2"
git push --atomic origin HEAD v0.22.2
```

Добавляйте в коммит только проверенные изменения: если до обновления были свои незавершённые правки, отделите их. Не добавляйте `node_modules`, `target` и `dist` — они не нужны в репозитории.

Затем откройте **Actions → Build installers** и дождитесь **Publish release**. Установщики появятся в **Releases → Neuron Map v0.22.2**. Используется встроенный `GITHUB_TOKEN`; отдельный персональный токен не нужен. В приватном репозитории релиз доступен только пользователям с доступом к нему.

При ошибке сборки можно повторить неуспешные задачи на том же коммите. Исправления кода требуют нового коммита и нового тега версии; номер тега должен совпадать с `package.json`. Если загрузка файлов релиза прервалась и оставила черновик, удалите именно этот незавершённый черновик на GitHub и повторите задачу публикации. Уже опубликованный релиз workflow не перезаписывает. Для следующих версий добавляйте соответствующий файл `releases/vX.Y.Z.md`.

Подпись издателя и нотариализация macOS не настроены. Лимиты минут GitHub Actions зависят от тарифа и видимости репозитория.

## 7. Проверка перед использованием

Для 0.22.2 локально проверяются сборка TypeScript/Vite, тесты логики и подготовки релиза, реальный Rust-код SQLite и кэша вложений, а также браузерный интерфейс с подменённым вызовом Tauri. Нативная упаковка выполняется на трёх целевых ОС в Actions. Браузерный тест не запускает внешнюю программу и не заменяет проверку готового установщика.

После получения установщиков проверьте на каждой ОС: установку, запуск из меню с закрытым терминалом, открытие узла, вложение и просмотр PDF/изображения, сохранение при закрытии, повторный запуск и единственный экземпляр. Дополнительно нажмите на вложенный TXT/PDF/DOCX и проверьте открытие в программе по умолчанию, повторное открытие, имя с кириллицей и **Save a copy**. Отредактируйте открытую копию и прикрепите её заново. Затем проверьте обновление с копией настоящих данных. До обновления сделайте **Save backup copy…** в `.neuron`.

Идентификатор `com.arsipro.neuronmap` и SQLite-формат сохранены. Установка не переносит данные с другого компьютера: для этого используйте экспорт/импорт `.neuron`. Не открывайте новую базу устаревшей версией приложения.

## Источники

- [Требования Tauri](https://v2.tauri.app/start/prerequisites/)
- [Встраивание frontendDist](https://v2.tauri.app/reference/config/#frontenddist)
- [Debian / Ubuntu](https://v2.tauri.app/distribute/debian/)
- [AppImage](https://v2.tauri.app/distribute/appimage/)
- [Windows installer и WebView2](https://v2.tauri.app/distribute/windows-installer/)
- [macOS DMG](https://v2.tauri.app/distribute/dmg/)
- [Сборки Tauri на GitHub](https://v2.tauri.app/distribute/pipelines/github/)
- [Экспорт файлов из Docker build](https://docs.docker.com/build/exporters/local-tar/)
