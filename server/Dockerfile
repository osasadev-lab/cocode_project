# syntax=docker/dockerfile:1

# ---- build ----
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/cocode-server ./cmd/server

# ---- run ----
# distroless keeps the deployed image tiny and dependency-free, which also
# keeps Cloud Run cold starts fast — relevant since cocode runs with
# min-instances=0 (spec §3).
FROM gcr.io/distroless/static-debian12
COPY --from=build /out/cocode-server /cocode-server
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/cocode-server"]
