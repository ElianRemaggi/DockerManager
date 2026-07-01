# Docker Manager UI

Interfaz web local para ver y operar contenedores Docker.

## Uso

```sh
npm start
```

Abrir `http://127.0.0.1:8088`.

## Configuración

- `HOST`: host de escucha. Por defecto `127.0.0.1`.
- `PORT`: puerto de escucha. Por defecto `8088`.
- `DOCKER_BIN`: binario Docker. Por defecto `docker`.

Para exponerlo en la red local:

```sh
HOST=0.0.0.0 PORT=8088 npm start
```

Esta app puede prender, apagar y reiniciar contenedores. No la expongas a internet sin autenticación o proxy seguro.
