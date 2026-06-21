import random
print("Random number:", random.random())
print("Random choice:", random.choice(['a', 'b', 'c', 'd']))

#slow code to test re-election
total = 0
for i in range(300_000_000):
    total += i
print("Done:", total)