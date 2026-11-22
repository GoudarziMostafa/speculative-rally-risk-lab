# Speculative Rally Risk Lab

[Open the live dashboard](https://goudarzimostafa.github.io/speculative-rally-risk-lab/)

I built this to see how the same trade turns out when buying pressure fades, persists, or the rally gets more fragile. You can change the assumptions and compare shares, margin, and short-dated calls across 4,000 simulated paths per scenario.

Try **Buying persists** and change **Days before buying starts to fade** from 15 to 5. With the default day-8 shares trade, the median goes from +15.4% to −19.5%. The assumptions are illustrative.

## Run it locally

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory dist
```

Open [localhost:8765](http://127.0.0.1:8765/). Run the tests with `node --test tests/model.test.mjs`. [Model notes and sources](MODEL.md)
