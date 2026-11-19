FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8080
WORKDIR /app

COPY backend/requirements.txt /app/backend/requirements.txt
RUN python -m pip install --no-cache-dir -r /app/backend/requirements.txt

RUN groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --create-home --shell /usr/sbin/nologin app

COPY --chown=app:app backend/ /app/backend/
COPY --chown=app:app frontend/ /app/frontend/

USER app
WORKDIR /app/backend
EXPOSE 8080
CMD ["python", "-m", "app.main"]
