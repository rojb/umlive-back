# @umlive/contracts

Tipos del metamodelo UML 2.5 y protocolo de operaciones, compartidos por
`apps/api` y `apps/web`.

**No es una carpeta de utilidades.** Es el contrato que impide que el protocolo
diverja entre las dos mitades. Si divergiera, el bug aparecería en producción
y no en el compilador.

## Cómo lo consumen las apps

No hay monorepo: cada app lo declara como dependencia local por ruta.

```json
"@umlive/contracts": "file:../../packages/contracts"
```

npm lo enlaza por symlink y corre el script `prepare`, que compila `dist/`.
Por eso **no hace falta construirlo a mano** antes de instalar las apps.

## Si lo tocás

`npm install` en las apps **no recompila** un `file:` que ya está enlazado.
Después de editar cualquier archivo de `src/`:

```bash
npm run build          # desde packages/contracts
```

O dejá `npm run dev` corriendo en watch mientras trabajás.

## Archivos

| Archivo | Qué define |
|---|---|
| `uml.ts` | Subconjunto del metamodelo UML 2.5. **Espeja los enums de `apps/api/prisma/schema.prisma`** — si divergen, el compilador no avisa y el bug sale al exportar XMI |
| `operations.ts` | El protocolo: `OperationRequest`, `OperationCommitted`, `OperationRejected`, los bloqueos, y `LOCK_REQUIREMENTS` |
| `events.ts` | Nombres de canal del WebSocket y paleta de presencia |

`LOCK_REQUIREMENTS` es la tabla del Apéndice A.3 del PRD en forma ejecutable:
qué bloqueos exige cada operación. El cliente la usa para pedirlos antes de
intentar; el servidor la vuelve a aplicar. **Es una optimización de interfaz,
nunca la autoridad.**
