# Editor и изображения

Выделите текст в поле CONTENT и выберите формат на панели: **B**, *I*, подчёркивание, зачёркивание, нижний **x₂** или верхний **x²** индекс. Сочетания Ctrl/Cmd+B, I и U также работают. Кнопка Clear снимает форматирование с выделенного текста.

Кнопка **Insert image** вставляет локальное изображение в текущую позицию. Также можно вставить изображение из буфера обмена или перетащить файл в содержимое. Поддерживаются PNG, JPEG, GIF, WebP, AVIF и BMP; действуют лимиты вложений 20 MiB на файл и 64 MiB на пространство.

Нажмите на изображение, чтобы открыть его. **Brush** рисует выбранным цветом и толщиной. **Eraser** стирает пометки, сохраняя исходное изображение. **Text** позволяет написать подпись, выбрать цвет и размер и нажать в нужном месте. Для изменения масштаба используйте Zoom.

**Undo**, **Redo** и **Clear annotations** относятся к пометкам в этом окне. **Save annotations** сохраняет их в заметку и пространство. Экспорт пространства включает изображение и слой пометок.

Кнопка **Remove image** убирает изображение из содержимого; исходный файл остаётся в ATTACHMENTS. Действие можно отменить через общий Undo.

Старые Markdown-заметки открываются без автоматической перезаписи. Кнопка **Markdown** позволяет править их исходный текст. После визуального редактирования с форматированием или изображениями заметка хранит структурированное содержимое; режим Read, внутренние ссылки, поиск и экспорт продолжают работать.

## Diagrams (0.24.0)

Click **Diagram** beside CONTENT to open the note's diagram window. Text and image annotations remain separate from the diagram.

- Choose a shape, then click the canvas. Double-click a shape to focus its Label field. The right panel changes colors, typography and size.
- Choose Connector, click the source shape, then the target. Select the connector to edit its label, routing and arrowhead. Connectors stay attached when shapes move or resize.
- Drag shapes to move them; use the blue lower-right handle to resize. Shift+click selects several shapes. Arrow keys nudge the selection; Shift+Arrow moves by 20 units.
- Wheel zooms around the cursor. Pan or Space+drag moves the view; Fit frames the drawing. Snap to grid can be disabled.
- Ctrl/Cmd+A selects all shapes. Ctrl/Cmd+D duplicates; Ctrl/Cmd+C/V copies and pastes within this editor. Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z undo and redo. Delete removes the selection and incident connectors.
- **Save diagram** or Ctrl/Cmd+S saves the editable drawing to the note; **Export SVG/PNG** saves a rendered image. Closing unsaved drawings asks before discarding.

Each note has one diagram. This is an offline diagram editor with its own JSON format; diagrams.net/mxGraph `.drawio` files are not supported. Limits: 500 shapes, 1000 connectors, 100,000 text characters, and the existing workspace attachment quota. PNG export is bounded to 4096 pixels on the longer side.

The diagram is an immutable attachment with MIME `application/vnd.neuron-map.diagram+json`. Replacing it updates only that note's attachment metadata and flushes workspace persistence. Original note text is unchanged. Prior bytes remain available to Undo/Redo and snapshots through existing attachment retention. Full workspace exports include the editable drawing; SVG/PNG exports are rendered copies.
