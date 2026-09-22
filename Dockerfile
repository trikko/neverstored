# Build your own image: the operator details are compiled in, so the instance you run
# says who you are, not who we are. Edit static/operator.ini before building.

FROM alpine:3.22 AS build

RUN apk add --no-cache gcc musl-dev ldc dub lld llvm-libunwind-static binutils

WORKDIR /src
COPY . .

# A clone has no operator.ini: it is gitignored so nobody publishes someone else's
# address by accident. Without one the build stops on a static assert, so fall back to
# the placeholders and let the instance admit it was never configured.
RUN cp -n static/operator.ini.example static/operator.ini || true
RUN dub build --build=container --compiler=ldc2

# A directory the process can create its socket in, since scratch has no shell to mkdir with.
RUN mkdir -p /empty

FROM scratch

COPY --from=build /src/neverstored /neverstored
COPY --from=build --chown=65534:65534 /empty /run

ENV NEVERSTORED_BIND=0.0.0.0 \
    NEVERSTORED_PORT=8080 \
    NEVERSTORED_SOCKET=/run/neverstored.sock

USER 65534:65534
EXPOSE 8080
ENTRYPOINT ["/neverstored"]
