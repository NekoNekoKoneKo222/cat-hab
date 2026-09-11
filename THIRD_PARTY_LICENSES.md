# Web VM 同梱コンポーネントのライセンスについて

Web VM機能は以下のオープンソースコンポーネントを使用しています。
いずれも改変せずバイナリ/ソースをそのまま同梱しています。

## v86 (x86エミュレータ本体)

- 配置場所: `public/vm/lib/libv86.js`, `public/vm/lib/v86.wasm`, `public/vm/lib/v86-fallback.wasm`
- ライセンス: Simplified BSD License (BSD-2-Clause)
- 配布元: https://github.com/copy/v86 (npm: `v86`)
- ライセンス全文: `public/vm/lib/LICENSE-v86.txt`

## SeaBIOS / VGA BIOS (エミュレータ用ファームウェア)

- 配置場所: `public/vm/bios/seabios.bin`, `public/vm/bios/vgabios.bin`
- 取得元: v86リポジトリに同梱されているビルド済みバイナリ
  (https://github.com/copy/v86/tree/master/bios)
- SeaBIOS本体はLGPLv3、Bochs由来のVGA BIOSはLGPLv2+ライセンスです。
  Cat Hubはこれらをビルド済みバイナリのまま無改変で再配布しています。
- 詳細: https://www.seabios.org/ , https://bochs.sourceforge.io/

これらのコンポーネントを更新する場合は、`npm view v86 version` で最新版を確認し、
`node_modules/v86/build/` 以下のファイルを `public/vm/lib/` へ再配置してください。
BIOSファイルはv86リポジトリの `bios/` ディレクトリから取得してください。
