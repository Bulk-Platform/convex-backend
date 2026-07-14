# Advanced Configuration and Tuning

There is a large number of detailed configuration options in
[knobs.rs](/crates/common/src/knobs.rs). These options are configurable via
environment variables. In order to tune your Convex instance at scale for your
workload, you may need to adjust these knobs. You will have to set these
environment variables by adding them to your `docker-compose.yml` file. Commonly
overriden knobs are listed in the `env` section of the
[`docker-compose.yml`](../docker/docker-compose.yml)

## `APPLICATION_MAX_CONCURRENT_*` knobs

You can increase the max concurrency on your self-hosted instance with these
environment variables. Note that increasing concurrency will increase load on
your system and after a certain threshold, performance will degrade. You will
have to tune parameters based on your own hardware and workload.

## Self-hosted HTTP listener concurrency

`LOCAL_BACKEND_MAX_CONCURRENT_REQUESTS` controls the number of requests accepted
concurrently by the self-hosted main backend listener. Its default is `128` for
backward compatibility.

`SITE_PROXY_MAX_CONCURRENT_REQUESTS` controls the number of public HTTP-action
requests accepted concurrently by the separate site proxy. Its default is `4`
for backward compatibility.

The self-hosted site port forwards public HTTP-action requests to the main
backend, so raising only the site proxy limit can move the queue to the main
listener or application action limit. Tune these limits together and load test
the result. For example, a large self-hosted deployment could start with:

```text
LOCAL_BACKEND_MAX_CONCURRENT_REQUESTS=512
SITE_PROXY_MAX_CONCURRENT_REQUESTS=256
APPLICATION_MAX_CONCURRENT_V8_ACTIONS=128
APPLICATION_MAX_CONCURRENT_QUERIES=64
APPLICATION_MAX_CONCURRENT_MUTATIONS=32
APPLICATION_MAX_CONCURRENT_NODE_ACTIONS=32
```

These are starting points, not universal defaults. Increase them gradually while
monitoring latency, queueing, CPU, and memory. The generic
`HTTP_SERVER_MAX_CONCURRENT_REQUESTS` knob does not control either self-hosted
`local_backend` listener.
