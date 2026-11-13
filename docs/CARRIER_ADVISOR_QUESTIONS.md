# Questions for the carrier advisors (Step 4.15)

Two emails the owner sends to the advisors of Forza and C807. Each answer becomes a mapping default or a declared
capability, never code written from a guess (`TDD_17 §14`). Status of each question is kept in the Step 4.15 section of
`IMPLEMENTATION_PLAN.md`; when an answer arrives, write it there and delete the line from here.

## C807 Express

Only one question is left (the others were answered on 2026-11-14: `SEC` is charged and kept by C807, and a COD guide goes with
the total to collect, C807 deducting its commission).

Subject: **Integración API Xpress: una consulta pendiente**

> Hola [nombre],
>
> ¿Las filas de `get_historia` incluyen el campo `devolucion` cuando un paquete regresa al remitente? Lo vemos en el
> webhook, pero no en la documentación del historial.
>
> Saludos.

## Forza Delivery Express

Subject: **Integración API Ecommerce: consultas técnicas pendientes**

> Hola [nombre],
>
> Gracias por la documentación del API v2.2. Estamos avanzando con la integración y nos faltan estos datos:
>
> 1. **Estados de rastreo.** En `GetTrackOrderDetail`, ¿cuál es la lista completa de `GuideStatusId` posibles, con su
>    significado? En el webhook vemos 2, 5, 14, 21, 22, 25 y 45, pero necesitamos el catálogo completo para mapear
>    cada estado.
> 2. **Seguridad del webhook.** ¿Las notificaciones llevan firma o algún header de autenticación para validar que
>    vienen de Forza? ¿Cómo se configura?
> 3. **Recolecta y devoluciones.** ¿Se puede modificar o cancelar una recolecta ya solicitada? ¿Existe guía de
>    devolución (de regreso al origen) por API?
> 4. **Referencia.** Si enviamos dos veces una creación de servicio con el mismo `CodeOfReference`, ¿se rechaza el
>    duplicado o se crea otra guía?
> 5. **Monto COD en 0.** ¿Una guía con monto COD en 0 se acepta, o debe crearse como servicio estándar sin COD?
> 6. **Quién paga el envío.** Si el producto ya está pagado y el envío lo paga el destinatario, ¿cómo se crea la guía?
>
> Quedamos atentos. Saludos.
